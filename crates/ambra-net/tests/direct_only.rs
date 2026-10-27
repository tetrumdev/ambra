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
