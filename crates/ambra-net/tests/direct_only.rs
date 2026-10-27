//! An authenticated peer asking for a data relay is rejected before any relay socket opens.
use libudx::UdxRuntime;
use peeroxide_dht::{
    hyperdht::{self, HyperDhtConfig, KeyPair, ServerEvent},
    hyperdht_messages::*,
    noise::Keypair,
    noise_wrap::NoiseWrap,
};
use std::time::Duration;
#[tokio::test]
async fn authenticated_data_relay_instruction_is_rejected() {
    let runtime = UdxRuntime::new().unwrap();
    let mut config = HyperDhtConfig::default();
    config.dht.host = "127.0.0.1".into();
    config.dht.firewalled = false;
    let (server_task, server, mut events) =
        hyperdht::spawn(&runtime, config.clone()).await.unwrap();
    let (client_task, client, _events) = hyperdht::spawn(&runtime, config).await.unwrap();
    let key = KeyPair::generate();
    let public_key = key.public_key;
    server.register_server(&peeroxide_dht::crypto::hash(&public_key));
    let port = server.local_port().await.unwrap();
    let responder = tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if let ServerEvent::PeerHandshake { msg, reply_tx, .. } = event {
                let mut noise = NoiseWrap::new_responder(Keypair {
                    public_key: key.public_key,
                    secret_key: key.secret_key,
                });
                noise.recv(&msg.noise).unwrap();
                let payload = NoisePayload {
                    version: 1,
                    error: 0,
                    firewall: FIREWALL_OPEN,
                    holepunch: None,
                    addresses4: vec![],
                    addresses6: vec![],
                    udx: Some(UdxInfo {
                        version: 1,
                        reusable_socket: true,
                        id: 1,
                        seq: 0,
                    }),
                    secret_stream: Some(SecretStreamInfo { version: 1 }),
                    relay_through: Some(RelayThroughInfo {
                        version: 1,
                        public_key: [11; 32],
                        token: [22; 32],
                    }),
                    relay_addresses: None,
                };
                let reply = HandshakeMessage {
                    mode: MODE_REPLY,
                    noise: noise.send(&payload).unwrap(),
                    peer_address: None,
                    relay_address: None,
                };
                reply_tx
                    .send(Some(encode_handshake_to_bytes(&reply).unwrap()))
                    .unwrap();
                break;
            }
        }
    });
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        client.connect_to(
            &KeyPair::generate(),
            public_key,
            format!("127.0.0.1:{port}").parse().unwrap(),
            &runtime,
        ),
    )
    .await
    .unwrap();
    assert!(matches!(
        result,
        Err(hyperdht::HyperDhtError::FirewallRejected)
    ));
    responder.await.unwrap();
    client.destroy().await.unwrap();
    server.destroy().await.unwrap();
    client_task.abort();
    server_task.abort();
}

#[tokio::test]
async fn direct_udx_stream_preserves_audio_across_packet_loss() {
    use axum::{Router, body::Body, routing::get};
    use http_body_util::BodyExt;
    use tokio_util::sync::CancellationToken;
    let runtime = UdxRuntime::new().unwrap();
    let mut config = peeroxide::SwarmConfig::default();
    config.dht.dht.host = "127.0.0.1".into();
    config.dht.dht.firewalled = false;
    let (server_task, server, mut incoming) = peeroxide::spawn(config).await.unwrap();
    let key = server.key_pair().public_key;
    server.dht().register_server(&peeroxide_dht::crypto::hash(&key));
    let destination = format!("127.0.0.1:{}", server.dht().local_port().await.unwrap()).parse().unwrap();
    let proxy = std::sync::Arc::new(tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap());
    let proxy_address = proxy.local_addr().unwrap();
    let proxy_task = tokio::spawn(async move {
        let mut peer = None;
        let mut data_packets = 0;
        let mut buffer = [0; 65536];
        let mut delayed = tokio::task::JoinSet::new();
        loop {
            let (length, sender) = tokio::select! {
                result = proxy.recv_from(&mut buffer) => result.unwrap(),
                Some(_) = delayed.join_next(), if !delayed.is_empty() => continue,
            };
            let target = if sender == destination { peer.unwrap() } else { peer = Some(sender); destination };
            // A lucky padded probe may survive fragmentation while a burst of
            // full data packets does not. Ethernet permits 1472 UDP payload bytes.
            if length > 1472 && buffer[3] == 0 { continue; }
            if length >= 20 && buffer[0] == 0xff && buffer[2] & 1 != 0 {
                data_packets += 1;
                if data_packets == 32 { continue; }
            }
            let delay = if data_packets % 19 == 0 { 90 } else { 25 };
            let bytes = buffer[..length].to_vec();
            let socket = proxy.clone();
            delayed.spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                socket.send_to(&bytes, target).await.unwrap();
            });
        }
    });
    let stop = CancellationToken::new();
    let app = Router::new().route("/audio", get(|| async { Body::from(vec![42; 512 * 1024]) }));
    let serving_stop = stop.clone();
    let serving = tokio::spawn(async move {
        let connection = incoming.recv().await.unwrap();
        assert!(connection.peer.remote_addr.is_some(), "accepted UDX must retain its actual endpoint");
        let peer = ambra_net::transport::RemotePeer { public_key: ambra_net::PublicKey(connection.peer.remote_public_key), address: connection.peer.remote_addr.unwrap(), session: std::sync::Arc::new(()) };
        let (io, pump) = ambra_net::transport::adapt(connection.peer.stream, Some(Box::new(connection.peer.socket)));
        ambra_net::transport::serve(io, pump, peer, app, serving_stop).await
    });
    let mut client_config = HyperDhtConfig::default();
    client_config.dht.host = "127.0.0.1".into();
    client_config.dht.firewalled = false;
    let (client_task, client, _) = hyperdht::spawn(&runtime, client_config).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        let connection = client.connect_to(&KeyPair::generate(), key, proxy_address, &runtime).await.unwrap();
        let (io, pump) = ambra_net::transport::adapt(connection.stream, Some(Box::new(connection.socket)));
        let http = ambra_net::transport::HttpConnection::new(io, pump).await.unwrap();
        let response = http.request(hyper::Request::builder().uri("/audio").body(Body::empty()).unwrap()).await.unwrap();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.len(), 512 * 1024);
        assert!(bytes.iter().all(|b| *b == 42));
        http.close();
    }).await.expect("direct encrypted UDX audio stalled after packet loss");
    stop.cancel();
    let _ = serving.await;
    client.destroy().await.unwrap(); server.destroy().await.unwrap();
    client_task.abort(); server_task.abort(); proxy_task.abort();
}
