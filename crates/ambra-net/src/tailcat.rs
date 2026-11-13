//! Final, relay-capable fallback. Only the Ambra service port is exposed.
mod native;
use crate::{
    Identity, PublicKey, Result, gate,
    signaling::{Binding, Message, Replay, Signaling},
    transport,
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
const PORT: u16 = 38149;

#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Address(String);
impl std::fmt::Debug for Address {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TailcatAddress([redacted])")
    }
}
impl TryFrom<String> for Address {
    type Error = &'static str;
    fn try_from(value: String) -> std::result::Result<Self, Self::Error> {
        if !value.starts_with("tc")
            || value.len() > 4096
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("Invalid Tailcat address");
        }
        Ok(Self(value))
    }
}
impl From<Address> for String {
    fn from(value: Address) -> Self {
        value.0
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub error: Option<String>,
}
#[derive(Default)]
pub struct ListenerState {
    pub status: Status,
    pub address: Option<Address>,
}
impl std::fmt::Debug for ListenerState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.status.fmt(f)
    }
}
pub type SharedState = Arc<RwLock<ListenerState>>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PeerPath {
    Unknown,
    Direct,
    Derp { region: u64 },
}
pub struct Diagnostics {
    latest: Arc<RwLock<PeerPath>>,
    _monitor: tokio_util::task::AbortOnDropHandle<()>,
}
impl Diagnostics {
    pub fn path(&self) -> PeerPath {
        self.latest
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}
impl PeerPath {
    fn from_ping(value: &serde_json::Value) -> Self {
        if value["endpoint"].as_str().is_some_and(|s| !s.is_empty()) {
            Self::Direct
        } else if let Some(region) = value["derp_region_id"].as_u64().filter(|id| *id != 0) {
            Self::Derp { region }
        } else {
            Self::Unknown
        }
    }
}

/// Exclusive creation and protected atomic replacement. Never follows existing symlinks.
pub(crate) fn read_private(path: &Path) -> Result<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        return Err("Secret storage must be a small regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Secret storage permissions must be 0600".into());
        }
    }
    Ok(std::fs::read(path)?)
}
pub(crate) fn write_private(path: &Path, bytes: &[u8], replace: bool) -> Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = if replace {
        path.with_extension(format!("{}.tmp", crate::signaling::nonce()?))
    } else {
        path.to_owned()
    };
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if replace {
            std::fs::rename(&temporary, path)?;
        }
        Ok(())
    })();
    if replace && result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
async fn server_config(path: &Path, derp_map_url: Option<String>) -> Result<String> {
    let bytes = match read_private(path) {
        Ok(bytes) => bytes,
        Err(error)
            if !path.try_exists()?
                && error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            let keys = native::keys().await?;
            match write_private(path, keys.as_bytes(), false) {
                Ok(()) => keys.into_bytes(),
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::AlreadyExists) =>
                {
                    read_private(path)?
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    };
    let keys: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Corrupt Tailcat identity; restore its backup")?;
    let key = keys["private_key"]
        .as_str()
        .ok_or("Missing Tailcat private key")?;
    let psk = keys["preshared_key"]
        .as_str()
        .ok_or("Missing Tailcat pre-shared key")?;
    Ok(serde_json::json!({"key":key,"preshared_key":psk,"derp_map_url":derp_map_url.unwrap_or_default()}).to_string())
}

#[derive(Debug)]
pub(crate) struct DialFailure;
impl std::fmt::Display for DialFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Tailcat tunnel unavailable")
    }
}
impl std::error::Error for DialFailure {}

/// One engine per encrypted application connection, never per HTTP request.
pub async fn connect(
    address: Address,
    identity: &Identity,
    server: PublicKey,
) -> Result<(tokio::io::DuplexStream, transport::Pump, Arc<Diagnostics>)> {
    let client =
        native::Resource::new(serde_json::json!({"address":address}).to_string(), false).await?;
    let mut raw = client.dial().await.map_err(|_| DialFailure)?;
    raw.write_all(&gate::knock(identity, server)).await?;
    let (io, _, pump) = transport::secure(raw, identity, Some(server)).await?;
    let path = client
        .path()
        .await
        .map(|value| PeerPath::from_ping(&value))
        .unwrap_or(PeerPath::Unknown);
    let latest = Arc::new(RwLock::new(path));
    let observed = latest.clone();
    let monitor = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let path = client
                .path()
                .await
                .map(|value| PeerPath::from_ping(&value))
                .unwrap_or(PeerPath::Unknown);
            *observed.write().unwrap_or_else(|p| p.into_inner()) = path;
        }
    });
    let diagnostics = Arc::new(Diagnostics {
        latest,
        _monitor: tokio_util::task::AbortOnDropHandle::new(monitor),
    });
    Ok((io, pump.retain(Box::new(diagnostics.clone())), diagnostics))
}

pub async fn discover(identity: Identity, server: PublicKey) -> Result<Address> {
    let signaling = Signaling::open(identity, &Signaling::defaults()).await?;
    let mut events = signaling.notifications();
    signaling.subscribe().await?;
    let binding = signaling.discover(server).await?;
    let session = crate::signaling::nonce()?;
    let admit: gate::Admit = Arc::new(move |key| *key == server);
    let mut replay = Replay::default();
    let mut retry = tokio::time::interval(Duration::from_secs(3));
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        loop { tokio::select! {
            _ = retry.tick() => signaling.send(&binding, &session, 0, Message::TailcatRequest {}).await?,
            payload = signaling.receive(&mut events, &admit, &mut replay) => {
                let payload = payload?;
                if payload.session == session && payload.attempt == 0 && payload.nostr == binding.nostr {
                    if let Message::TailcatAddress { address } = payload.message { return Ok::<_, crate::Error>(address); }
                }
            }
        }}
    }).await?;
    signaling.shutdown().await;
    result
}
async fn discovery_server(
    identity: Identity,
    state: SharedState,
    admit: gate::Admit,
    cancel: CancellationToken,
    relays: Vec<String>,
) -> Result<()> {
    let signaling = Signaling::open(identity, &relays).await?;
    let mut events = signaling.notifications();
    signaling.subscribe().await?;
    signaling.announce().await?;
    let mut replay = Replay::default();
    let mut refresh = tokio::time::interval(Duration::from_secs(6 * 3600));
    let mut rate = std::collections::HashMap::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = refresh.tick() => signaling.announce().await?,
            payload = signaling.receive(&mut events, &admit, &mut replay) => {
                let payload = payload?;
                if !matches!(payload.message, Message::TailcatRequest {}) || !admit(&payload.sender) { continue; }
                rate.retain(|_, at: &mut std::time::Instant| at.elapsed() < Duration::from_secs(3));
                if rate.contains_key(&payload.sender) || rate.len() >= 64 { continue; }
                rate.insert(payload.sender, std::time::Instant::now());
                let address = state.read().unwrap_or_else(|p| p.into_inner()).address.clone();
                if let Some(address) = address {
                    let peer = Binding {version:1, device:payload.sender, nostr:payload.nostr};
                    signaling.send(&peer, &payload.session, payload.attempt, Message::TailcatAddress {address}).await?;
                }
            }
        }
    }
    signaling.shutdown().await;
    Ok(())
}

pub async fn serve(
    identity: Identity,
    key_path: std::path::PathBuf,
    app: axum::Router,
    admit: gate::Admit,
    state: SharedState,
    derp_map_url: Option<String>,
    cancel: CancellationToken,
) -> Result<()> {
    serve_with(
        identity,
        key_path,
        app,
        admit,
        state,
        derp_map_url,
        cancel,
        Signaling::defaults(),
    )
    .await
}

pub(crate) async fn serve_with(
    identity: Identity,
    key_path: std::path::PathBuf,
    app: axum::Router,
    admit: gate::Admit,
    state: SharedState,
    derp_map_url: Option<String>,
    cancel: CancellationToken,
    relays: Vec<String>,
) -> Result<()> {
    let server = native::Resource::new(server_config(&key_path, derp_map_url).await?, true).await?;
    let listener = tokio::select! { _ = cancel.cancelled() => return Ok(()), result = server.listen() => result? };
    let info = server.info().await?;
    let address = Address::try_from(
        info["address"]
            .as_str()
            .ok_or("Missing Tailcat address")?
            .to_owned(),
    )?;
    *state.write().unwrap_or_else(|p| p.into_inner()) = ListenerState {
        status: Status {
            running: true,
            error: None,
        },
        address: Some(address),
    };
    let mut tasks = tokio::task::JoinSet::new();
    let (discovery_identity, discovery_state, discovery_admit, discovery_cancel) = (
        identity.clone(),
        state.clone(),
        admit.clone(),
        cancel.clone(),
    );
    if !relays.is_empty() {
        tasks.spawn(async move {
        loop {
            tokio::select! { _ = discovery_cancel.cancelled() => return, _ = discovery_server(discovery_identity.clone(), discovery_state.clone(), discovery_admit.clone(), discovery_cancel.clone(), relays.clone()) => {} }
            tokio::select! { _ = discovery_cancel.cancelled() => return, _ = tokio::time::sleep(Duration::from_secs(15)) => {} }
        }
    });
    }
    let replay = Arc::new(gate::Replay::default());
    let mut connections = tokio::task::JoinSet::new();
    let result = loop {
        tokio::select! {
            _ = cancel.cancelled() => break Ok(()),
            accepted = listener.accept(server.clone()), if connections.len() < 64 => {
                let mut raw = match accepted { Ok(raw) => raw, Err(error) => break Err(error) };
                let identity = identity.clone(); let admit = admit.clone(); let replay = replay.clone(); let app = app.clone(); let stop = cancel.clone();
                connections.spawn(async move {
                    let handshake = async {
                        let mut knock = [0; gate::KNOCK_LEN]; raw.read_exact(&mut knock).await?;
                        let expected = gate::check_knock(&knock, identity.public_key(), &admit, &replay).ok_or("Tailcat device admission denied")?;
                        let (io, peer, pump) = transport::secure(raw, &identity, None).await?;
                        if peer.public_key != expected || !admit(&expected) { return Err("Tailcat device identity denied".into()); }
                        Ok::<_, crate::Error>((io, peer, pump))
                    };
                    if let Ok(Ok((io, peer, pump))) = tokio::time::timeout(Duration::from_secs(10), handshake).await { let _ = transport::serve(io, pump, peer, app, stop).await; }
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    };
    state.write().unwrap_or_else(|p| p.into_inner()).address = None;
    state
        .write()
        .unwrap_or_else(|p| p.into_inner())
        .status
        .running = false;
    tasks.shutdown().await;
    connections.shutdown().await;
    listener.close().await;
    server.close().await;
    result
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) struct Relay(std::process::Child);
    impl Drop for Relay {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    pub(crate) async fn relay() -> (Relay, String) {
        use std::io::BufRead;
        let (relay, url) = tokio::task::spawn_blocking(|| {
            // Build separately so killing the fixture also kills its only process.
            let binary = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target/tailcat-testrelay");
            assert!(
                std::process::Command::new("go")
                    .args(["build", "-mod=readonly", "-o"])
                    .arg(&binary)
                    .arg("./testrelay")
                    .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/tailcat"))
                    .status()
                    .unwrap()
                    .success()
            );
            let mut relay = Relay(
                std::process::Command::new(binary)
                    .stdout(std::process::Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
            let mut url = String::new();
            std::io::BufReader::new(relay.0.stdout.take().unwrap())
                .read_line(&mut url)
                .unwrap();
            (relay, url.trim().to_owned())
        })
        .await
        .unwrap();
        (relay, url)
    }

    #[test]
    fn relay_is_never_reported_as_direct() {
        assert_eq!(
            PeerPath::from_ping(&serde_json::json!({"endpoint":"", "derp_region_id":1})),
            PeerPath::Derp { region: 1 }
        );
        assert_eq!(
            PeerPath::from_ping(&serde_json::json!({})),
            PeerPath::Unknown
        );
        assert_eq!(
            PeerPath::from_ping(&serde_json::json!({"endpoint":"192.0.2.2:123"})),
            PeerPath::Direct
        );
        assert!(
            !format!("{:?}", Address::try_from("tcSECRET".to_owned()).unwrap()).contains("SECRET")
        );
    }
    #[tokio::test]
    async fn identity_persists_and_corruption_never_rotates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("identity");
        let first = server_config(&path, None).await.unwrap();
        assert_eq!(first, server_config(&path, None).await.unwrap());
        std::fs::write(&path, b"broken").unwrap();
        assert!(server_config(&path, None).await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"broken");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn private_derp_carries_noise_http2_exact_streams_ranges_and_denies_revocation() {
        use axum::{Router, body::Body, routing::get};
        use http_body_util::BodyExt;
        let (_relay, url) = relay().await;
        let directory = tempfile::tempdir().unwrap();
        let server_identity = Identity::generate().unwrap();
        let server_key = server_identity.public_key();
        let client_identity = Identity::generate().unwrap();
        let client_key = client_identity.public_key();
        let revoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let allowed = revoked.clone();
        let admit: gate::Admit = Arc::new(move |key| {
            *key == client_key && !allowed.load(std::sync::atomic::Ordering::SeqCst)
        });
        let bytes = Arc::new(
            (0..2 * 1024 * 1024)
                .map(|i| (i % 251) as u8)
                .collect::<Vec<_>>(),
        );
        let body = bytes.clone();
        let access = revoked.clone();
        let app = Router::new().route(
            "/api/audio",
            get(
                move |headers: axum::http::HeaderMap,
                      peer: axum::Extension<transport::RemotePeer>| {
                    let body = body.clone();
                    let access = access.clone();
                    async move {
                        assert_eq!(peer.0.public_key, client_key);
                        if access.load(std::sync::atomic::Ordering::SeqCst)
                            || headers.get("authorization").and_then(|h| h.to_str().ok())
                                != Some("Bearer test")
                        {
                            return axum::response::Response::builder()
                                .status(401)
                                .body(Body::empty())
                                .unwrap();
                        }
                        let range = headers.contains_key("range");
                        axum::response::Response::builder()
                            .status(if range { 206 } else { 200 })
                            .body(Body::from(if range {
                                body[100..200].to_vec()
                            } else {
                                body.as_ref().clone()
                            }))
                            .unwrap()
                    }
                },
            ),
        );
        let state: SharedState = Default::default();
        let cancel = CancellationToken::new();
        let task = tokio::spawn(serve_with(
            server_identity.clone(),
            directory.path().join("keys"),
            app,
            admit,
            state.clone(),
            Some(url),
            cancel.clone(),
            Vec::new(),
        ));
        let address = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if let Some(address) = state.read().unwrap().address.clone() {
                    break address;
                }
                assert!(
                    !task.is_finished(),
                    "Tailcat server exited before listening"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let (io, pump, path) = connect(address.clone(), &client_identity, server_key)
            .await
            .unwrap();
        assert!(matches!(
            path.path(),
            PeerPath::Direct | PeerPath::Derp { .. }
        ));
        let connection = transport::HttpConnection::new(io, pump).await.unwrap();
        let request = |range: bool, token: &str| {
            let mut request = hyper::Request::builder()
                .uri("/api/audio")
                .header("authorization", token);
            if range {
                request = request.header("range", "bytes=100-199");
            }
            request.body(Body::empty()).unwrap()
        };
        let (full, range) = tokio::join!(
            connection.request(request(false, "Bearer test")),
            connection.request(request(true, "Bearer test"))
        );
        assert_eq!(range.as_ref().unwrap().status(), 206);
        assert_eq!(
            full.unwrap()
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            bytes.as_slice()
        );
        assert_eq!(
            range
                .unwrap()
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .as_ref(),
            &bytes[100..200]
        );
        assert_eq!(
            connection
                .request(request(false, "invalid"))
                .await
                .unwrap()
                .status(),
            401
        );
        revoked.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            connection
                .request(request(false, "Bearer test"))
                .await
                .unwrap()
                .status(),
            401
        );
        assert!(
            tokio::time::timeout(
                Duration::from_secs(12),
                connect(address, &client_identity, server_key)
            )
            .await
            .unwrap()
            .is_err()
        );
        connection.close();
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(!state.read().unwrap().status.running);
    }
}
