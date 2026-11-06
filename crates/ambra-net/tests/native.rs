use ambra_net::{
    ConnectionManager, ConnectionState, Identity, SelectedServer, lan, pairing::PairingPayload,
    pwnat,
};
use axum::{
    Router,
    body::Body,
    extract::Request,
    http::{StatusCode, header},
    middleware::Next,
    response::IntoResponse,
    routing::{get, post},
};
use bytes::Bytes;
use futures_util::StreamExt;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

async fn harness() -> (
    Identity,
    std::net::SocketAddr,
    CancellationToken,
    tokio::task::JoinHandle<ambra_net::Result<()>>,
    Arc<AtomicUsize>,
) {
    let identity = Identity::generate().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let cancel = CancellationToken::new();
    let count = Arc::new(AtomicUsize::new(0));
    let commands = count.clone();
    let app = Router::new()
        .route("/api/network/session", get(|| async { "authorized" }))
        .route(
            "/api/stream",
            get(|| async {
                Body::from_stream(futures_util::stream::iter(
                    (0..512).map(|_| Ok::<_, std::io::Error>(Bytes::from_static(&[42; 16 * 1024]))),
                ))
            }),
        )
        .route(
            "/api/range",
            get(|request: Request| async move {
                if request
                    .headers()
                    .get(header::RANGE)
                    .is_some_and(|v| v == "bytes=100-199")
                {
                    (
                        StatusCode::PARTIAL_CONTENT,
                        [(header::CONTENT_RANGE, "bytes 100-199/1000")],
                        vec![7_u8; 100],
                    )
                        .into_response()
                } else {
                    vec![7_u8; 1000].into_response()
                }
            }),
        )
        .route(
            "/api/longpoll",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                "update"
            }),
        )
        .route("/api/echo", post(|body: Body| async { body }))
        .route(
            "/api/command",
            post(move || {
                let commands = commands.clone();
                async move {
                    commands.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    "done"
                }
            }),
        )
        .layer(axum::middleware::from_fn(
            |request: Request, next: Next| async {
                assert!(
                    request
                        .extensions()
                        .get::<ambra_net::transport::RemotePeer>()
                        .is_some()
                );
                if request
                    .headers()
                    .get(header::AUTHORIZATION)
                    .is_none_or(|v| v != "Bearer fixture-token")
                {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                next.run(request).await
            },
        ));
    let task = tokio::spawn(lan::serve(listener, identity.clone(), app, cancel.clone()));
    (identity, address, cancel, task, count)
}
fn manager(identity: &Identity, address: std::net::SocketAddr) -> Arc<ConnectionManager> {
    ConnectionManager::new(
        Identity::generate().unwrap(),
        SelectedServer {
            public_key: identity.public_key(),
            local_addresses: vec![address],
            public_endpoint: None,
            public_tcp: vec![],
        },
        Some("fixture-token".into()),
    )
}

#[tokio::test]
async fn repeated_server_switches_close_transports_without_stopping_servers() {
    let first = harness().await;
    let second = harness().await;
    let client = reqwest::Client::new();
    for server in [&first, &second, &first, &second] {
        let manager = manager(&server.0, server.1);
        let connection = manager.connect().await.unwrap();
        let bridge = ambra_net::bridge::Bridge::start(manager.clone()).await.unwrap();
        let url = format!("{}/api/range", bridge.base_url);
        assert!(client.get(&url).send().await.unwrap().status().is_success());
        bridge.shutdown().await;
        assert!(connection.is_closed());
        assert_eq!(manager.status().state, ConnectionState::Offline);
        assert!(manager.connect().await.is_err());
        assert!(client.get(url).send().await.is_err());
        assert!(!server.3.is_finished(), "switching must never stop the independent server");
    }
    first.2.cancel(); second.2.cancel();
    first.3.await.unwrap().unwrap(); second.3.await.unwrap().unwrap();
}
#[test]
fn identities_persist_and_corruption_does_not_rotate() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("identity");
    let first = Identity::load_or_create(&path).unwrap().public_key();
    assert_eq!(first, Identity::load_or_create(&path).unwrap().public_key());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    std::fs::write(&path, b"corrupt").unwrap();
    assert!(Identity::load_or_create(&path).is_err());
    assert_eq!(std::fs::read(path).unwrap(), b"corrupt");
}
#[test]
fn public_pairing_payload_is_versioned_bounded_and_has_no_credentials() {
    let payload = PairingPayload {
        version: 1,
        public_key: Identity::generate().unwrap().public_key(),
        name: "Core".into(),
        local_addresses: vec!["[::1]:38149".parse().unwrap()],
        public_endpoint: None,
        public_tcp: vec![],
    };
    let encoded = payload.encode().unwrap();
    assert_eq!(
        PairingPayload::decode(&encoded).unwrap().public_key,
        payload.public_key
    );
    assert!(!serde_json::to_string(&payload).unwrap().contains("secret"));
    let mut invalid = payload.clone();
    invalid.version = 2;
    assert!(invalid.encode().is_err());
    assert!(PairingPayload::decode(&"x".repeat(9000)).is_err());
    invalid = payload;
    invalid.local_addresses = vec!["8.8.8.8:80".parse().unwrap()];
    assert!(invalid.encode().is_err());
}
#[test]
fn independent_icmp_packets_validate_and_reject_corruption_or_other_echoes() {
    let key = Identity::generate().unwrap().public_key();
    let packet = pwnat::time_exceeded("203.0.113.1".parse().unwrap(), key);
    assert_eq!(pwnat::checksum(&packet), 0);
    assert!(pwnat::validate_time_exceeded(&packet, key));
    for length in 0..packet.len() {
        assert!(!pwnat::validate_time_exceeded(&packet[..length], key));
    }
    for index in 0..packet.len() {
        let mut bad = packet.clone();
        bad[index] ^= 1;
        assert!(!pwnat::validate_time_exceeded(&bad, key));
    }
    assert!(!pwnat::validate_time_exceeded(
        &packet,
        Identity::generate().unwrap().public_key()
    ));
    let mut outer = vec![0; 20];
    outer[0] = 0x45;
    outer[9] = 1;
    outer.extend_from_slice(&packet);
    assert!(pwnat::validate_time_exceeded(&outer, key));
}
#[tokio::test]
async fn unknown_server_key_is_rejected_before_application_authentication() {
    let (_identity, address, cancel, task, _) = harness().await;
    let stranger = Identity::generate().unwrap();
    assert!(
        lan::connect(
            address,
            stranger.public_key(),
            &Identity::generate().unwrap()
        )
        .await
        .is_err()
    );
    cancel.cancel();
    task.await.unwrap().unwrap();
}
#[tokio::test]
async fn encrypted_streaming_ranges_uploads_and_concurrent_polling_use_same_http_handlers() {
    let (identity, address, cancel, task, _) = harness().await;
    let manager = manager(&identity, address);
    let connected_at = std::time::Instant::now();
    manager.connect().await.unwrap();
    println!("LAN authenticated connection: {:?}", connected_at.elapsed());
    assert_eq!(manager.status().state, ConnectionState::ConnectedLocal);
    let bridge = ambra_net::bridge::Bridge::start(manager.clone())
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let streaming_at = std::time::Instant::now();
    let stream = client
        .get(format!("{}/api/stream", bridge.base_url))
        .send()
        .await
        .unwrap();
    let mut stream = stream.bytes_stream();
    let (total, poll) = tokio::join!(
        async {
            let mut total = 0;
            while let Some(bytes) = stream.next().await {
                let bytes = bytes.unwrap();
                assert!(bytes.iter().all(|b| *b == 42));
                total += bytes.len();
            }
            total
        },
        client
            .get(format!("{}/api/longpoll", bridge.base_url))
            .send()
    );
    assert_eq!(total, 8 * 1024 * 1024);
    println!(
        "8 MiB streaming with concurrent 100 ms poll: {:?}",
        streaming_at.elapsed()
    );
    assert_eq!(poll.unwrap().text().await.unwrap(), "update");
    let range = client
        .get(format!("{}/api/range", bridge.base_url))
        .header(header::RANGE, "bytes=100-199")
        .send()
        .await
        .unwrap();
    assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(range.headers()[header::CONTENT_RANGE], "bytes 100-199/1000");
    assert_eq!(range.bytes().await.unwrap().len(), 100);
    let body = vec![19_u8; 1024 * 1024];
    let echoed = client
        .post(format!("{}/api/echo", bridge.base_url))
        .body(body.clone())
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(echoed.as_ref(), body);
    drop(bridge);
    cancel.cancel();
    task.await.unwrap().unwrap();
}
#[tokio::test]
async fn bridge_denies_missing_capabilities_rebinding_hostile_origins_and_local_management() {
    let (identity, address, cancel, task, _) = harness().await;
    let bridge = ambra_net::bridge::Bridge::start(manager(&identity, address))
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let parsed = reqwest::Url::parse(&bridge.base_url).unwrap();
    let origin = parsed.origin().ascii_serialization();
    for request in [
        client.get(format!("{origin}/api/range")),
        client.get(format!("{}/api/local/config", bridge.base_url)),
        client
            .get(format!("{}/api/range", bridge.base_url))
            .header(header::HOST, "evil.example"),
        client
            .get(format!("{}/api/range", bridge.base_url))
            .header(header::ORIGIN, "http://evil.example"),
    ] {
        assert_eq!(
            request.send().await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    let response = client
        .get(format!("{}/api/range", bridge.base_url))
        .header(header::ORIGIN, "tauri://localhost")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        "tauri://localhost"
    );
    drop(bridge);
    cancel.cancel();
    task.await.unwrap().unwrap();
}
#[tokio::test]
async fn cancelling_a_mutation_does_not_replay_it() {
    let (identity, address, cancel, task, count) = harness().await;
    let manager = manager(&identity, address);
    manager.connect().await.unwrap();
    let bridge = ambra_net::bridge::Bridge::start(manager).await.unwrap();
    let url = format!("{}/api/command", bridge.base_url);
    let client = reqwest::Client::new();
    let request = tokio::spawn(async move { client.post(url).send().await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    request.abort();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    drop(bridge);
    cancel.cancel();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn failed_authorization_never_reports_connected() {
    let (identity, address, cancel, task, _) = harness().await;
    let manager = ConnectionManager::with_timing(
        Identity::generate().unwrap(),
        SelectedServer {
            public_key: identity.public_key(),
            local_addresses: vec![address],
            public_endpoint: None,
            public_tcp: vec![],
        },
        Some("revoked".into()),
        ambra_net::manager::Timing {
            lan: Duration::from_secs(2),
            pwnat: Duration::from_millis(1),
            hyperdht: Duration::ZERO,
            retry: Duration::from_secs(1),
            ..Default::default()
        },
    );
    assert!(manager.connect().await.is_err());
    assert_eq!(manager.status().state, ConnectionState::Offline);
    assert!(
        manager
            .status()
            .error
            .as_deref()
            .unwrap()
            .contains("authorization failed")
    );
    cancel.cancel();
    task.await.unwrap().unwrap();
}
#[tokio::test]
async fn ipv6_lan_authenticates_without_internet_when_available() {
    let Ok(listener) = tokio::net::TcpListener::bind("[::1]:0").await else {
        return;
    };
    let address = listener.local_addr().unwrap();
    let identity = Identity::generate().unwrap();
    let cancel = CancellationToken::new();
    let task = tokio::spawn(lan::serve(
        listener,
        identity.clone(),
        Router::new(),
        cancel.clone(),
    ));
    let (io, pump) = lan::connect(
        address,
        identity.public_key(),
        &Identity::generate().unwrap(),
    )
    .await
    .unwrap();
    drop(io);
    drop(pump);
    cancel.cancel();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn reconnect_preserves_selected_identity_and_stable_bridge() {
    let (identity, address, cancel, task, _) = harness().await;
    let manager = manager(&identity, address);
    let connection = manager.connect().await.unwrap();
    let bridge = ambra_net::bridge::Bridge::start(manager.clone())
        .await
        .unwrap();
    let stable = bridge.base_url.clone();
    cancel.cancel();
    task.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(2), connection.closed())
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind(address).await.unwrap();
    let stop = CancellationToken::new();
    let app = Router::new()
        .route("/api/network/session", get(|| async { "authorized" }))
        .route("/api/restored", get(|| async { "same server" }));
    let restarted = tokio::spawn(lan::serve(listener, identity.clone(), app, stop.clone()));
    manager.connect().await.unwrap();
    assert_eq!(bridge.base_url, stable);
    assert_eq!(manager.status().server, identity.public_key());
    assert_eq!(
        reqwest::get(format!("{stable}/api/restored"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "same server"
    );
    bridge.shutdown().await;
    stop.cancel();
    restarted.await.unwrap().unwrap();
}

#[test]
fn tailscale_pairing_hints_round_trip_but_never_become_public_traversal_endpoints() {
    let identity = Identity::generate().unwrap();
    for address in ["100.106.252.60:38149", "[fd7a:115c:a1e0::f537:fc3d]:38149", "[::ffff:100.117.211.104]:38149"] {
        let address: std::net::SocketAddr = address.parse().unwrap();
        assert!(!lan::is_local(address.ip()));
        let mut payload = PairingPayload { version: 1, public_key: identity.public_key(), name: "Tailscale".into(), local_addresses: vec![address], public_endpoint: None, public_tcp: vec![] };
        let decoded = PairingPayload::decode(&payload.encode().unwrap()).unwrap();
        assert_eq!(decoded.local_addresses, vec![address]);
        assert_eq!(decoded.public_key, identity.public_key());
        payload.local_addresses.clear();
        payload.public_endpoint = Some(address);
        assert!(payload.encode().is_err());
    }
    assert!(lan::local_addresses(38149).iter().all(|a| !peeroxide_dht::address_policy::is_overlay(a.ip())));
}

/// Runs against this machine's real overlay interfaces without changing routes or credentials.
#[tokio::test]
#[ignore = "Requires an active Tailscale interface"]
async fn tailscale_interfaces_carry_pinned_authenticated_http_and_audio_ranges() {
    let addresses: Vec<_> = if_addrs::get_if_addrs().unwrap().into_iter()
        .map(|interface| interface.ip())
        .filter(|ip| peeroxide_dht::address_policy::is_overlay(*ip)).collect();
    assert!(!addresses.is_empty(), "Start Tailscale before running this test");
    for ip in addresses {
        let identity = Identity::generate().unwrap();
        let listener = tokio::net::TcpListener::bind(std::net::SocketAddr::new(ip, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        assert!(lan::direct_addresses(address.port()).contains(&address));
        let stop = CancellationToken::new();
        let app = Router::new()
            .route("/api/network/session", get(|request: Request| async move {
                if request.headers().get(header::AUTHORIZATION).is_some_and(|v| v == "Bearer fixture-token") {
                    StatusCode::OK
                } else { StatusCode::UNAUTHORIZED }
            }))
            .route("/api/audio", get(|request: Request| async move {
                if request.headers().get(header::AUTHORIZATION).is_none_or(|v| v != "Bearer fixture-token") {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                assert_eq!(request.headers().get(header::RANGE).unwrap(), "bytes=100-199");
                (StatusCode::PARTIAL_CONTENT, [(header::CONTENT_RANGE, "bytes 100-199/1000")], vec![7_u8; 100]).into_response()
            }));
        let task = tokio::spawn(lan::serve(listener, identity.clone(), app, stop.clone()));
        let selected = SelectedServer { public_key: identity.public_key(), local_addresses: vec![address], public_endpoint: None, public_tcp: vec![] };
        // Disable public discovery: this must succeed even when bootstrap UDP is blocked.
        let timing = ambra_net::manager::Timing { hyperdht: Duration::ZERO, lan_grace: Duration::from_secs(3), ..Default::default() };
        let manager = ConnectionManager::with_timing(Identity::generate().unwrap(), selected.clone(), Some("fixture-token".into()), timing.clone());
        let connection = tokio::time::timeout(Duration::from_secs(3), manager.connect()).await.unwrap().unwrap();
        assert_eq!(manager.status().state, ConnectionState::ConnectedLocal);
        let response = manager.request(hyper::Request::builder().uri("/api/audio")
            .header(header::RANGE, "bytes=100-199").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 100-199/1000");
        use http_body_util::BodyExt;
        assert_eq!(response.into_body().collect().await.unwrap().to_bytes().as_ref(), &[7_u8; 100]);
        let wrong = Identity::generate().unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(3), lan::connect(address, wrong.public_key(), &wrong)).await.unwrap().is_err());
        let unauthorized = ConnectionManager::with_timing(Identity::generate().unwrap(), selected, Some("wrong-token".into()), timing);
        assert!(tokio::time::timeout(Duration::from_secs(3), unauthorized.connect()).await.unwrap().is_err());
        unauthorized.shutdown().await;
        connection.close();
        manager.shutdown().await;
        stop.cancel();
        task.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn enrollment_authorizes_on_the_same_encrypted_connection() {
    let (identity, address, cancel, task, _) = harness().await;
    let manager = ConnectionManager::new(Identity::generate().unwrap(), SelectedServer {
        public_key: identity.public_key(), local_addresses: vec![address], public_endpoint: None, public_tcp: vec![],
    }, None);
    let enrollment = manager.connect().await.unwrap();
    assert_eq!(manager.status().state, ConnectionState::Authenticating);
    assert!(manager.authorize("wrong-token".into()).await.is_err());
    assert_eq!(manager.status().state, ConnectionState::Authenticating);
    manager.authorize("fixture-token".into()).await.unwrap();
    assert_eq!(manager.status().state, ConnectionState::ConnectedLocal);
    assert!(Arc::ptr_eq(&enrollment, &manager.connect().await.unwrap()));
    let bridge = ambra_net::bridge::Bridge::start(manager.clone()).await.unwrap();
    let response = reqwest::Client::new().get(format!("{}/api/range", bridge.base_url)).send().await.unwrap();
    assert!(response.status().is_success());
    bridge.shutdown().await;
    cancel.cancel();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn connection_waiters_share_authorization_when_first_waiter_is_cancelled() {
    let identity = Identity::generate().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let authorizations = Arc::new(AtomicUsize::new(0));
    let app = Router::new().route(
        "/api/network/session",
        get({
            let entered = entered.clone();
            let release = release.clone();
            let count = authorizations.clone();
            move || {
                let entered = entered.clone();
                let release = release.clone();
                let count = count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    entered.notify_one();
                    release.notified().await;
                    "authorized"
                }
            }
        }),
    );
    let server = tokio::spawn(lan::serve(listener, identity.clone(), app, stop.clone()));
    let manager = manager(&identity, address);
    let first = tokio::spawn({
        let manager = manager.clone();
        async move { manager.connect().await }
    });
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    first.abort();
    let mut waiters = tokio::task::JoinSet::new();
    for _ in 0..32 {
        let manager = manager.clone();
        waiters.spawn(async move { manager.connect().await.unwrap() });
    }
    tokio::task::yield_now().await;
    release.notify_one();
    let connection = manager.connect().await.unwrap();
    while let Some(waiter) = waiters.join_next().await {
        assert!(Arc::ptr_eq(&connection, &waiter.unwrap()));
    }
    assert_eq!(authorizations.load(Ordering::SeqCst), 1);
    manager.shutdown().await;
    assert!(connection.is_closed());
    assert!(manager.connect().await.is_err());
    stop.cancel();
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn shutdown_cancels_shared_authorization_and_all_waiters() {
    let identity = Identity::generate().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let app = Router::new().route(
        "/api/network/session",
        get({
            let entered = entered.clone();
            move || {
                let entered = entered.clone();
                async move {
                    entered.notify_one();
                    std::future::pending::<&'static str>().await
                }
            }
        }),
    );
    let stop = CancellationToken::new();
    let server = tokio::spawn(lan::serve(listener, identity.clone(), app, stop.clone()));
    let manager = manager(&identity, address);
    let waiter = tokio::spawn({
        let manager = manager.clone();
        async move { manager.connect().await }
    });
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), manager.shutdown())
        .await
        .unwrap();
    assert!(waiter.await.unwrap().is_err());
    assert_eq!(manager.status().state, ConnectionState::Offline);
    assert!(manager.connect().await.is_err());
    stop.cancel();
    server.await.unwrap().unwrap();
}

/// The song's first response breaks partway; the bridge resumes with a byte range and the
/// player, reading through the cache, still gets every byte in order.
#[tokio::test]
async fn cached_audio_survives_a_broken_response_and_serves_ranges() {
    const SIZE: usize = 3 * 1024 * 1024;
    let song: Arc<Vec<u8>> = Arc::new((0..SIZE).map(|i| (i % 251) as u8).collect());
    let identity = Identity::generate().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let cancel = CancellationToken::new();
    let requests = Arc::new(std::sync::Mutex::new(Vec::<Option<String>>::new()));
    let seen = requests.clone();
    let served = song.clone();
    let app = Router::new()
        .route("/api/network/session", get(|| async { "authorized" }))
        .route("/api/providers/test/tracks/1/stream", get(move |request: Request| {
            let song = served.clone();
            let seen = seen.clone();
            async move {
                let range = request.headers().get(header::RANGE).map(|v| v.to_str().unwrap().to_owned());
                let first = seen.lock().unwrap().is_empty();
                seen.lock().unwrap().push(range.clone());
                let start: usize = range.as_deref().and_then(|r| r.strip_prefix("bytes=")).and_then(|r| r.split('-').next()).and_then(|s| s.parse().ok()).unwrap_or(0);
                let rest = song[start..].to_vec();
                let length = rest.len();
                let chunks: Vec<Result<Bytes, std::io::Error>> = rest.chunks(64 * 1024).enumerate().map(|(index, chunk)| {
                    // The first response dies after a few chunks, as a dropped Wi-Fi link would.
                    if first && index == 5 { Err(std::io::Error::other("link lost")) } else { Ok(Bytes::copy_from_slice(chunk)) }
                }).collect();
                let delivered = futures_util::stream::iter(chunks).then(|chunk| async move {
                    // Give earlier chunks time to reach the client before the link fails.
                    if chunk.is_err() { tokio::time::sleep(Duration::from_millis(300)).await; }
                    chunk
                });
                let mut response = Body::from_stream(delivered).into_response();
                response.headers_mut().insert(header::CONTENT_LENGTH, length.into());
                response.headers_mut().insert(header::CONTENT_TYPE, "audio/flac".parse().unwrap());
                if start > 0 {
                    *response.status_mut() = StatusCode::PARTIAL_CONTENT;
                    response.headers_mut().insert(header::CONTENT_RANGE, format!("bytes {start}-{}/{SIZE}", SIZE - 1).parse().unwrap());
                }
                response
            }
        }));
    let task = tokio::spawn(lan::serve(listener, identity.clone(), app, cancel.clone()));
    let directory = std::env::temp_dir().join(format!("ambra-media-cache-test-{}", std::process::id()));
    let bridge = ambra_net::bridge::Bridge::start_with_cache(manager(&identity, address), Some(directory.clone())).await.unwrap();
    let client = reqwest::Client::new();
    let url = format!("{}/api/providers/test/tracks/1/stream", bridge.base_url);

    let whole = client.get(&url).send().await.unwrap();
    assert_eq!(whole.status(), StatusCode::OK);
    assert_eq!(whole.headers()[header::CONTENT_TYPE], "audio/flac");
    assert_eq!(whole.bytes().await.unwrap().as_ref(), song.as_slice());
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2, "one broken response, then one resumed range: {requests:?}");
        assert_eq!(requests[0], None);
        assert!(requests[1].as_deref().is_some_and(|range| range.starts_with("bytes=") && range != "bytes=0-"), "{requests:?}");
    }

    // Later reads come from disk, with no further requests to the server.
    let part = client.get(&url).header(header::RANGE, "bytes=1000-1999").send().await.unwrap();
    assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(part.headers()[header::CONTENT_RANGE], format!("bytes 1000-1999/{SIZE}"));
    assert_eq!(part.bytes().await.unwrap().as_ref(), &song[1000..2000]);
    assert_eq!(requests.lock().unwrap().len(), 2);

    bridge.prefetch("/api/session");
    drop(bridge);
    cancel.cancel();
    task.await.unwrap().unwrap();
    let _ = std::fs::remove_dir_all(directory);
}
