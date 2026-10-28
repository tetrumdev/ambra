#![deny(clippy::all)]

mod common;

use common::{create_bound_socket, create_runtime, with_timeout};
use std::time::Duration;

#[tokio::test]
async fn firewall_hook_accepts_first_packet() {
    let _ = tracing_subscriber::fmt::try_init();

    with_timeout(Duration::from_secs(10), async {
        let rt = create_runtime();

        let (socket_a, addr_a) = create_bound_socket(&rt).await;
        let (socket_b, _addr_b) = create_bound_socket(&rt).await;

        let id_a = 10u32;
        let id_b = 20u32;

        let mut stream_a = rt.create_stream(id_a).await.expect("create stream_a");
        stream_a
            .set_firewall_hook(&socket_a, id_b, |_, _, _| true)
            .expect("set_firewall_hook");

        let stream_b = rt.create_stream(id_b).await.expect("create stream_b");
        stream_b
            .connect(&socket_b, id_a, addr_a)
            .await
            .expect("stream_b connect");

        let msg = b"hello from firewall hook test";
        stream_b.write(msg).await.expect("stream_b write");

        let data = stream_a
            .read()
            .await
            .expect("stream_a read")
            .expect("stream_a unexpected EOF");
        assert_eq!(&data[..], msg.as_ref());
    })
    .await;
}

fn flagless_packet(stream_id: u32) -> Vec<u8> {
    let mut packet = vec![0; 20];
    packet[0] = 0xff;
    packet[1] = 1;
    packet[4..8].copy_from_slice(&stream_id.to_le_bytes());
    packet
}

async fn expect_fallback(sender: &libudx::UdxSocket, receiver: &libudx::UdxSocket, packet: &[u8]) {
    let mut rx = receiver.recv_start().unwrap();
    let addr = receiver.local_addr().await.unwrap();
    with_timeout(Duration::from_secs(3), async {
        let mut retry = tokio::time::interval(Duration::from_millis(50));
        loop {
            tokio::select! {
                received = rx.recv() => {
                    assert_eq!(received.unwrap().data, packet);
                    break;
                }
                _ = retry.tick() => sender.send_to(packet, addr).unwrap(),
            }
        }
    })
    .await;
}

#[tokio::test]
async fn firewall_hook_commits_secondary_socket_and_cleans_candidates() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    with_timeout(Duration::from_secs(10), async {
        let rt = create_runtime();
        let (primary, primary_addr) = create_bound_socket(&rt).await;
        let (secondary, secondary_addr) = create_bound_socket(&rt).await;
        let (loser, _) = create_bound_socket(&rt).await;
        let (client_socket, client_addr) = create_bound_socket(&rt).await;
        let server = rt.create_stream(101).await.unwrap();
        let (winner_tx, mut winner_rx) = tokio::sync::oneshot::channel();
        server
            .set_firewall_hook(&primary, 102, move |socket, port, ip| {
                assert!(
                    winner_tx
                        .send((socket.clone(), std::net::SocketAddr::new(ip, port)))
                        .is_ok()
                );
                true
            })
            .unwrap();
        server.add_firewall_socket(&secondary).unwrap();
        server.add_firewall_socket(&secondary).unwrap(); // idempotent
        let add_candidate = server.firewall_socket_adder();
        let mut server = server.into_async_stream();
        add_candidate(&loser).unwrap();

        // A demuxable but implausible packet must not select a socket.
        for _ in 0..4 {
            client_socket
                .send_to(&flagless_packet(101), primary_addr)
                .unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(matches!(
            winner_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        drop(secondary); // candidate registrations retain sockets until selection

        let client = rt.create_stream(102).await.unwrap();
        client
            .connect(&client_socket, 101, secondary_addr)
            .await
            .unwrap();
        let mut client = client.into_async_stream();
        client.write_all(b"ping").await.unwrap();
        let mut buf = [0; 4];
        server.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"ping");
        let (winner, remote) = winner_rx.await.unwrap();
        assert_eq!(winner.local_addr().await.unwrap(), secondary_addr);
        assert_eq!(remote, client_addr);
        assert!(
            add_candidate(&loser).is_err(),
            "no new candidates after commitment"
        );

        server.write_all(b"pong").await.unwrap();
        client.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"pong"); // client accepts traffic only from secondary_addr
        expect_fallback(&client_socket, &primary, &flagless_packet(101)).await;
        expect_fallback(&client_socket, &loser, &flagless_packet(101)).await;

        drop(server);
        expect_fallback(&client_socket, &winner, &flagless_packet(101)).await;
        assert!(add_candidate(&loser).is_err());
    })
    .await;
}

#[tokio::test]
async fn firewall_candidate_registrations_cleaned_on_drop_and_rejection() {
    with_timeout(Duration::from_secs(10), async {
        let rt = create_runtime();
        let (primary, _) = create_bound_socket(&rt).await;
        let (secondary, secondary_addr) = create_bound_socket(&rt).await;
        let (sender, _) = create_bound_socket(&rt).await;
        let server = rt.create_stream(201).await.unwrap();
        assert!(server.add_firewall_socket(&secondary).is_err());
        server
            .set_firewall_hook(&primary, 202, |_, _, _| true)
            .unwrap();
        let unbound = rt.create_socket().await.unwrap();
        assert!(server.add_firewall_socket(&unbound).is_err());
        server.add_firewall_socket(&secondary).unwrap();
        let add_candidate = server.firewall_socket_adder();
        drop(server); // also covers cancellation before the processor's first poll
        expect_fallback(&sender, &primary, &flagless_packet(201)).await;
        expect_fallback(&sender, &secondary, &flagless_packet(201)).await;
        assert!(add_candidate(&secondary).is_err());

        let server = rt.create_stream(201).await.unwrap();
        let (rejected_tx, rejected_rx) = tokio::sync::oneshot::channel();
        server
            .set_firewall_hook(&primary, 202, move |_, _, _| {
                rejected_tx.send(()).unwrap();
                false
            })
            .unwrap();
        server.add_firewall_socket(&secondary).unwrap();
        let peer = rt.create_stream(202).await.unwrap();
        peer.connect(&sender, 201, secondary_addr).await.unwrap();
        let write = tokio::spawn(async move { peer.write(b"reject").await });
        rejected_rx.await.unwrap();
        expect_fallback(&sender, &primary, &flagless_packet(201)).await;
        expect_fallback(&sender, &secondary, &flagless_packet(201)).await;
        write.abort();
    })
    .await;
}

#[tokio::test]
async fn firewall_cleanup_preserves_reused_stream_id() {
    with_timeout(Duration::from_secs(10), async {
        let rt = create_runtime();
        let (primary, _) = create_bound_socket(&rt).await;
        let (secondary, addr) = create_bound_socket(&rt).await;
        let (client_socket, _) = create_bound_socket(&rt).await;
        let old = rt.create_stream(401).await.unwrap();
        old.set_firewall_hook(&primary, 402, |_, _, _| true)
            .unwrap();
        old.add_firewall_socket(&secondary).unwrap();
        drop(old.into_async_stream()); // cleanup runs asynchronously

        let mut replacement = rt.create_stream(401).await.unwrap();
        replacement
            .set_firewall_hook(&primary, 402, |_, _, _| true)
            .unwrap();
        replacement.add_firewall_socket(&secondary).unwrap();
        let client = rt.create_stream(402).await.unwrap();
        client.connect(&client_socket, 401, addr).await.unwrap();
        client.write(b"replacement").await.unwrap();
        assert_eq!(replacement.read().await.unwrap().unwrap(), b"replacement");
    })
    .await;
}

#[tokio::test]
async fn queued_server_greeting_waits_for_firewall_endpoint() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    with_timeout(Duration::from_secs(3), async {
        let runtime = create_runtime();
        let (server_socket, server_address) = create_bound_socket(&runtime).await;
        let (client_socket, _) = create_bound_socket(&runtime).await;
        let server = runtime.create_stream(301).await.unwrap();
        server
            .set_firewall_hook(&server_socket, 302, |_, _, _| true)
            .unwrap();
        let mut server = server.into_async_stream();
        let greeting = tokio::spawn(async move {
            server.write_all(b"server greeting").await.unwrap();
            let mut hello = [0; 5];
            server.read_exact(&mut hello).await.unwrap();
            assert_eq!(&hello, b"hello");
            server.flush().await.unwrap();
        });
        // Allow the listener's pacing task to run before any peer is known.
        tokio::time::sleep(Duration::from_millis(30)).await;
        let client = runtime.create_stream(302).await.unwrap();
        client
            .connect(&client_socket, 301, server_address)
            .await
            .unwrap();
        let mut client = client.into_async_stream();
        let start = std::time::Instant::now();
        client.write_all(b"hello").await.unwrap();
        let mut bytes = [0; 15];
        client.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"server greeting");
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "greeting waited for an RTO after premature send"
        );
        greeting.await.unwrap();
    })
    .await;
}
