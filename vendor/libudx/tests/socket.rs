#![deny(clippy::all)]

mod common;

use std::net::SocketAddr;
use std::time::Duration;

use common::{DEFAULT_TIMEOUT, create_bound_socket, create_runtime, with_timeout};

#[tokio::test]
async fn socket_bind_and_local_addr() {
    let _ = tracing_subscriber::fmt::try_init();

    with_timeout(DEFAULT_TIMEOUT, async {
        let runtime = create_runtime();
        let (socket, addr) = create_bound_socket(&runtime).await;

        assert!(
            addr.port() > 0,
            "expected non-zero port, got {}",
            addr.port()
        );
        assert_eq!(addr.ip(), "127.0.0.1".parse::<std::net::IpAddr>().unwrap());

        socket.close().await.expect("close failed");
    })
    .await;
}

#[tokio::test]
async fn socket_send_recv_datagram() {
    let _ = tracing_subscriber::fmt::try_init();

    with_timeout(DEFAULT_TIMEOUT, async {
        let runtime = create_runtime();
        let (socket_a, addr_a) = create_bound_socket(&runtime).await;
        let (socket_b, addr_b) = create_bound_socket(&runtime).await;

        let mut rx = socket_b.recv_start().expect("recv_start failed");

        let test_data = b"hello datagram";
        socket_a.send_to(test_data, addr_b).expect("send_to failed");

        let datagram = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("recv timed out")
            .expect("channel closed");

        assert_eq!(datagram.data, test_data);
        assert_eq!(datagram.addr.port(), addr_a.port());

        socket_a.close().await.expect("close a failed");
        socket_b.close().await.expect("close b failed");
    })
    .await;
}

#[tokio::test]
async fn socket_probe_ttl_does_not_leak_to_normal_sends() {
    with_timeout(DEFAULT_TIMEOUT, async {
        let runtime = create_runtime();
        let (sender, _) = create_bound_socket(&runtime).await;
        let (receiver, addr) = create_bound_socket(&runtime).await;
        let mut rx = receiver.recv_start().expect("recv_start failed");
        // Use a nonstandard default to catch hard-coded restoration to 64.
        sender.set_ttl(93).expect("set_ttl failed");

        for round in 0..8 {
            sender
                .send_to_with_ttl(b"probe", addr, 5)
                .expect("probe failed");
            if round == 0 {
                // On a current-thread runtime the spawned send has not run yet.
                assert_eq!(sender.ttl().unwrap(), 93);
            }
            assert_eq!(rx.recv().await.unwrap().data, b"probe");
            assert_eq!(sender.ttl().unwrap(), 93, "probe changed the default TTL");

            sender
                .send_to(b"reflection", addr)
                .expect("normal send failed");
            assert_eq!(rx.recv().await.unwrap().data, b"reflection");
            assert_eq!(sender.ttl().unwrap(), 93);
        }
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn socket_concurrent_probes_normal_sends_and_udx() {
    with_timeout(DEFAULT_TIMEOUT, async {
        let runtime = create_runtime();
        let (stream_a, mut stream_b, socket_a, socket_b) =
            common::create_connected_pair(&runtime).await;
        let addr_b = socket_b.local_addr().await.unwrap();
        let mut rx = socket_b.recv_start().unwrap();
        socket_a.set_ttl(93).unwrap();

        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(5));
        let mut tasks = Vec::new();
        for worker in 0..4u8 {
            let socket = socket_a.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                for sequence in 0..16u8 {
                    let data = [worker, sequence];
                    if worker % 2 == 0 {
                        socket.send_to_with_ttl(&data, addr_b, 5).unwrap();
                    } else {
                        socket.send_to(&data, addr_b).unwrap();
                    }
                    assert_eq!(socket.ttl().unwrap(), 93);
                    tokio::task::yield_now().await;
                }
            }));
        }

        barrier.wait().await;
        let writer = tokio::spawn(async move {
            stream_a.write(b"concurrent UDX data").await.unwrap();
            stream_a.destroy().await.unwrap();
        });
        assert_eq!(
            stream_b.read().await.unwrap().unwrap(),
            b"concurrent UDX data"
        );
        let mut seen = std::collections::HashSet::new();
        for _ in 0..64 {
            let datagram = rx.recv().await.unwrap();
            assert!(seen.insert(datagram.data), "duplicate datagram");
            assert_eq!(socket_a.ttl().unwrap(), 93);
        }
        for task in tasks {
            task.await.unwrap();
        }
        writer.await.unwrap();
        stream_b.destroy().await.unwrap();
        assert_eq!(socket_a.ttl().unwrap(), 93);
    })
    .await;
}

#[tokio::test]
async fn socket_close() {
    let _ = tracing_subscriber::fmt::try_init();

    with_timeout(DEFAULT_TIMEOUT, async {
        let runtime = create_runtime();
        let socket = runtime.create_socket().await.expect("create socket failed");
        socket
            .bind("127.0.0.1:0".parse::<SocketAddr>().unwrap())
            .await
            .expect("bind failed");

        socket.close().await.expect("close failed");
    })
    .await;
}
