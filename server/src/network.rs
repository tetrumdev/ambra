//! Sharing the server with other devices: pairing clients, and the settings the CLI changes.
//!
//! A client on another device asks to pair and is shown a six-digit code; someone at the
//! server approves that code (`ambra-server pair approve`, or the app on the server machine),
//! and the client then receives a token it sends with every request. Requests from the server
//! machine itself are trusted, so that machine's app and the CLI need no token.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, RwLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;

use crate::server_config::{PairedClient, ServerConfig, random_bytes, random_hex, token_hash};

const PAIRING_EXPIRES: Duration = Duration::from_secs(10 * 60);
const MAX_PENDING: usize = 16;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
struct PendingPairing {
    code: String,
    client_id: String,
    client_name: String,
    peer: String,
    requested: Instant,
    /// Set once approved; handed to the client on its next poll, then forgotten.
    token: Option<String>,
    denied: bool,
    client_key: Option<ambra_net::PublicKey>,
}

pub struct Network {
    pub config: RwLock<ServerConfig>,
    pub identity: ambra_net::Identity,
    pub secure_listening: RwLock<Option<SocketAddr>>,
    pub dht_status: ambra_net::hyperdht::SharedStatus,
    pub pwnat_status: RwLock<Option<String>>,
    pub lan_error: RwLock<Option<String>>,
    pub discovery_error: RwLock<Option<String>>,
    pub changed: tokio::sync::Notify,
    pub authenticated_sessions: RwLock<HashMap<String, Vec<std::sync::Weak<()>>>>,
    pending: Mutex<HashMap<String, PendingPairing>>,
    /// The address actually listened on, which an environment override may have changed.
    pub listening: RwLock<Option<SocketAddr>>,
}

pub type SharedNetwork = Arc<Network>;

impl Network {
    #[cfg(test)]
    pub fn new(config: ServerConfig) -> SharedNetwork { Self::with_identity(config, ambra_net::Identity::generate().unwrap()) }

    pub fn with_identity(config: ServerConfig, identity: ambra_net::Identity) -> SharedNetwork {
        Arc::new(Self {
            config: RwLock::new(config),
            identity,
            secure_listening: RwLock::new(None),
            dht_status: Arc::new(RwLock::new(Default::default())),
            pwnat_status: RwLock::new(None),
            lan_error: RwLock::new(None),
            discovery_error: RwLock::new(None),
            changed: tokio::sync::Notify::new(),
            authenticated_sessions: RwLock::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            listening: RwLock::new(None),
        })
    }

    pub fn paired_client_id(&self, token: &str, peer_key: Option<ambra_net::PublicKey>) -> Option<String> {
        // One read lock makes token validity, revocation and identity binding one decision.
        let config = self.config.read().ok()?;
        let client = config.client_for_token(token)?;
        client.public_key.is_none_or(|key| Some(key) == peer_key).then(|| client.id.clone())
    }

    fn update(&self, change: impl FnOnce(&mut ServerConfig) -> Result<(), String>) -> Result<ServerConfig, String> {
        let mut config = self.config.write().map_err(|_| "Server settings are unavailable")?;
        let mut next = config.clone();
        change(&mut next)?;
        next.save()?;
        *config = next.clone();
        self.changed.notify_one();
        Ok(next)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

/// Routes open to unpaired devices: what this server is, and asking to pair with it.
pub fn public_router<S: Clone + Send + Sync + 'static>(network: SharedNetwork) -> Router<S> {
    Router::new()
        .route("/api/server/info", get(info))
        .route("/api/network/session", get(authenticated_session))
        .route("/api/pair/request", post(request_pairing))
        .route("/api/pair/request/{request_id}", get(pairing_status))
        .with_state(network)
}

/// Routes only the server machine may call (see `access::LOCAL_ONLY_PREFIX`).
pub fn local_router<S: Clone + Send + Sync + 'static>(network: SharedNetwork) -> Router<S> {
    Router::new()
        .route("/api/local/network", get(network_status))
        .route("/api/local/pairing/qr", get(pairing_payload))
        .route("/api/local/pairing", get(list_pairing))
        .route("/api/local/pairing/approve", post(approve))
        .route("/api/local/pairing/deny", post(deny))
        .route("/api/local/pairing/revoke", post(revoke))
        .route("/api/local/config", get(show_config).post(change_config))
        .route("/api/local/stop", post(stop_server))
        .with_state(network)
}

async fn stop_server() -> Json<serde_json::Value> {
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(150)).await;
        crate::server_process::stop();
    });
    Json(json!({ "stopping": true }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub service: &'static str,
    pub id: String,
    pub name: String,
    pub version: &'static str,
    pub port: u16,
    pub on_network: bool,
    pub public_key: ambra_net::PublicKey,
    pub secure_port: Option<u16>,
}

pub fn server_info(network: &Network) -> ServerInfo {
    let config = network.config.read().map(|config| config.clone()).unwrap_or_else(|poisoned| poisoned.into_inner().clone());
    let address = network.listening.read().ok().and_then(|address| *address).unwrap_or_else(|| config.address());
    ServerInfo {
        service: "ambra",
        id: config.id,
        name: config.name,
        version: VERSION,
        port: address.port(),
        on_network: !address.ip().is_loopback(),
        public_key: network.identity.public_key(),
        secure_port: network.secure_listening.read().ok().and_then(|a| a.map(|a| a.port())),
    }
}

async fn info(State(network): State<SharedNetwork>) -> Json<ServerInfo> {
    Json(server_info(&network))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingRequest {
    client_id: String,
    client_name: String,
}

fn valid_client_field(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}

fn expire(pending: &mut HashMap<String, PendingPairing>) {
    pending.retain(|_, pairing| pairing.requested.elapsed() < PAIRING_EXPIRES);
}

async fn request_pairing(
    State(network): State<SharedNetwork>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<SocketAddr>,
    remote: Option<axum::Extension<ambra_net::transport::RemotePeer>>,
    Json(request): Json<PairingRequest>,
) -> Response {
    if !valid_client_field(&request.client_id, 64) || !valid_client_field(&request.client_name, 64) {
        return error(StatusCode::BAD_REQUEST, "A client ID and name of at most 64 characters are required");
    }
    let client_key = remote.map(|remote| remote.0.public_key);
    if client_key.is_none() && !peer.ip().is_loopback() {
        return error(StatusCode::UPGRADE_REQUIRED, "Pair over the native encrypted transport using the server pairing link");
    }
    let mut pending = network.pending.lock().await;
    expire(&mut pending);
    if pending.values().any(|p| p.peer == peer.ip().to_string() && p.requested.elapsed() < Duration::from_secs(2)) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Wait before requesting another pairing code");
    }
    // A client asking again replaces its earlier request, so retries don't fill the list.
    pending.retain(|_, pairing| pairing.client_id != request.client_id || pairing.client_key != client_key);
    if pending.len() >= MAX_PENDING {
        return error(StatusCode::TOO_MANY_REQUESTS, "Too many devices are waiting to pair; try again later");
    }
    let code = loop {
        let number = u32::from_le_bytes(random_bytes::<4>()) % 1_000_000;
        let code = format!("{number:06}");
        if !pending.values().any(|pairing| pairing.code == code) {
            break code;
        }
    };
    let request_id = random_hex(16);
    pending.insert(
        request_id.clone(),
        PendingPairing {
            code: code.clone(),
            client_id: request.client_id,
            client_name: request.client_name.trim().to_owned(),
            peer: peer.ip().to_string(),
            requested: Instant::now(),
            token: None,
            denied: false,
            client_key,
        },
    );
    Json(json!({ "requestId": request_id, "code": code, "expiresInSeconds": PAIRING_EXPIRES.as_secs() })).into_response()
}

async fn pairing_status(State(network): State<SharedNetwork>, Path(request_id): Path<String>, remote: Option<axum::Extension<ambra_net::transport::RemotePeer>>) -> Response {
    let mut pending = network.pending.lock().await;
    expire(&mut pending);
    let Some(pairing) = pending.get(&request_id).cloned() else {
        return Json(json!({ "status": "expired" })).into_response();
    };
    if pairing.client_key != remote.map(|r| r.0.public_key) { return error(StatusCode::FORBIDDEN, "Pairing belongs to another encrypted device identity"); }
    if pairing.denied {
        pending.remove(&request_id);
        return Json(json!({ "status": "denied" })).into_response();
    }
    match pairing.token {
        Some(token) => {
            pending.remove(&request_id);
            Json(json!({ "status": "approved", "token": token, "server": server_info(&network) })).into_response()
        }
        None => Json(json!({ "status": "pending" })).into_response(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingView {
    code: String,
    client_name: String,
    address: String,
    age_seconds: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairedView {
    id: String,
    name: String,
    paired_at_ms: u64,
}

async fn list_pairing(State(network): State<SharedNetwork>) -> Response {
    let mut pending = network.pending.lock().await;
    expire(&mut pending);
    let mut waiting = pending
        .values()
        .filter(|pairing| pairing.token.is_none() && !pairing.denied)
        .map(|pairing| PendingView {
            code: pairing.code.clone(),
            client_name: pairing.client_name.clone(),
            address: pairing.peer.clone(),
            age_seconds: pairing.requested.elapsed().as_secs(),
        })
        .collect::<Vec<_>>();
    waiting.sort_by_key(|pairing| pairing.age_seconds);
    let paired = network
        .config
        .read()
        .map(|config| {
            config
                .paired_clients
                .iter()
                .map(|client| PairedView { id: client.id.clone(), name: client.name.clone(), paired_at_ms: client.paired_at_ms })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Json(json!({ "pending": waiting, "paired": paired })).into_response()
}

#[derive(Deserialize)]
struct CodeBody {
    code: String,
}

async fn approve(State(network): State<SharedNetwork>, Json(body): Json<CodeBody>) -> Response {
    let mut pending = network.pending.lock().await;
    expire(&mut pending);
    let code = body.code.trim().replace(['-', ' '], "");
    let Some(pairing) = pending.values_mut().find(|pairing| pairing.code == code && pairing.token.is_none() && !pairing.denied) else {
        return error(StatusCode::NOT_FOUND, "No device is waiting with that code");
    };
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<32>());
    let client = PairedClient {
        id: pairing.client_id.clone(),
        name: pairing.client_name.clone(),
        token_sha256: token_hash(&token),
        paired_at_ms: now_ms(),
        public_key: pairing.client_key,
    };
    let saved = network.update(|config| {
        // Pairing again replaces the device's old token.
        config.paired_clients.retain(|existing| existing.id != client.id);
        config.paired_clients.push(client.clone());
        Ok(())
    });
    if let Err(message) = saved {
        return error(StatusCode::INTERNAL_SERVER_ERROR, message);
    }
    pairing.token = Some(token);
    Json(json!({ "paired": pairing.client_name })).into_response()
}

async fn deny(State(network): State<SharedNetwork>, Json(body): Json<CodeBody>) -> Response {
    let mut pending = network.pending.lock().await;
    let code = body.code.trim().replace(['-', ' '], "");
    match pending.values_mut().find(|pairing| pairing.code == code && pairing.token.is_none()) {
        Some(pairing) => {
            pairing.denied = true;
            Json(json!({ "denied": pairing.client_name })).into_response()
        }
        None => error(StatusCode::NOT_FOUND, "No device is waiting with that code"),
    }
}

#[derive(Deserialize)]
struct ClientBody {
    /// The client's ID, or its name when that is unambiguous.
    client: String,
}

async fn revoke(State(network): State<SharedNetwork>, Json(body): Json<ClientBody>) -> Response {
    let wanted = body.client.trim().to_owned();
    let mut removed = None;
    let result = network.update(|config| {
        let matches = config
            .paired_clients
            .iter()
            .filter(|client| client.id == wanted || client.name.eq_ignore_ascii_case(&wanted))
            .map(|client| client.id.clone())
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [] => Err(format!("No paired device is called \"{wanted}\"")),
            [id] => {
                removed = config.paired_clients.iter().find(|client| &client.id == id).map(|client| client.name.clone());
                config.paired_clients.retain(|client| &client.id != id);
                Ok(())
            }
            _ => Err(format!("Several devices are called \"{wanted}\"; use its ID from `pair list`")),
        }
    });
    match result {
        Ok(_) => Json(json!({ "revoked": removed })).into_response(),
        Err(message) => error(StatusCode::NOT_FOUND, message),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigView {
    id: String,
    name: String,
    bind: String,
    listening: Option<String>,
    discovery: bool,
    p2p: bool,
    paired_clients: usize,
    path: String,
}

fn config_view(network: &Network) -> ConfigView {
    let config = network.config.read().map(|config| config.clone()).unwrap_or_else(|poisoned| poisoned.into_inner().clone());
    ConfigView {
        id: config.id,
        name: config.name,
        bind: config.bind,
        listening: network.listening.read().ok().and_then(|address| *address).map(|address| address.to_string()),
        discovery: config.discovery,
        p2p: config.p2p,
        paired_clients: config.paired_clients.len(),
        path: ServerConfig::path().display().to_string(),
    }
}

async fn show_config(State(network): State<SharedNetwork>) -> Json<ConfigView> {
    Json(config_view(&network))
}

#[derive(Deserialize)]
struct ConfigChange {
    name: Option<String>,
    bind: Option<String>,
    discovery: Option<bool>,
    p2p: Option<bool>,
    public_endpoint: Option<SocketAddr>,
}

async fn change_config(State(network): State<SharedNetwork>, Json(change): Json<ConfigChange>) -> Response {
    let result = network.update(|config| {
        if let Some(name) = &change.name {
            crate::server_config::validate_name(name)?;
            config.name = name.trim().to_owned();
        }
        if let Some(bind) = &change.bind {
            config.bind = crate::server_config::parse_bind(bind)?.to_string();
        }
        if let Some(p2p) = change.p2p { config.p2p = p2p; }
        if let Some(endpoint) = change.public_endpoint { config.public_endpoint = Some(endpoint); }
        if let Some(discovery) = change.discovery {
            config.discovery = discovery;
        }
        Ok(())
    });
    match result {
        Ok(_) => Json(config_view(&network)).into_response(),
        Err(message) => error(StatusCode::BAD_REQUEST, message),
    }
}

async fn authenticated_session(caller: axum::Extension<crate::access::Caller>) -> Json<serde_json::Value> {
    Json(json!({ "clientId": caller.0.client_id }))
}

async fn network_status(State(network): State<SharedNetwork>) -> Json<serde_json::Value> {
    let config = network.config.read().unwrap_or_else(|p| p.into_inner());
    let dht = network.dht_status.read().unwrap_or_else(|p| p.into_inner()).clone();
    Json(json!({
        "running": true, "discovery": config.discovery, "p2p": config.p2p,
        "publicKey": network.identity.public_key(),
        "listening": *network.listening.read().unwrap_or_else(|p| p.into_inner()),
        "secureListening": *network.secure_listening.read().unwrap_or_else(|p| p.into_inner()),
        "hyperdht": dht, "pwnat": ambra_net::pwnat::capability(),
        "pwnatError": *network.pwnat_status.read().unwrap_or_else(|p| p.into_inner()),
        "lanError": *network.lan_error.read().unwrap_or_else(|p| p.into_inner()),
        "discoveryError": *network.discovery_error.read().unwrap_or_else(|p| p.into_inner()),
        "pairedDevices": config.paired_clients.len(),
        "authenticatedConnectedDevices": network.authenticated_sessions.read().map(|sessions| sessions.iter().filter(|(id, sessions)| config.paired_clients.iter().any(|c| &c.id == *id) && sessions.iter().any(|s| s.strong_count() > 0)).count()).unwrap_or(0),
        "dataRelay": false,
    }))
}

async fn pairing_payload(State(network): State<SharedNetwork>) -> Response {
    let info = server_info(&network);
    if !info.on_network { return error(StatusCode::BAD_REQUEST, "Enable LAN sharing before pairing another device"); }
    let config = network.config.read().unwrap_or_else(|p| p.into_inner());
    let payload = ambra_net::pairing::PairingPayload {
        version: 1, public_key: info.public_key, name: info.name,
        local_addresses: info.secure_port.map(ambra_net::lan::local_addresses).unwrap_or_default(),
        public_endpoint: config.public_endpoint,
    };
    match payload.encode() {
        Ok(link) => {
            let svg = qrcode::QrCode::new(link.as_bytes()).map(|code| code.render::<qrcode::render::svg::Color>().min_dimensions(256, 256).build()).ok();
            Json(json!({ "payload": link, "publicKey": payload.public_key, "svg": svg })).into_response()
        },
        Err(error) => error_response(error.to_string()),
    }
}
fn error_response(message: String) -> Response { error(StatusCode::INTERNAL_SERVER_ERROR, message) }

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn enrollment_polling_requires_the_same_key_and_expiry_removes_the_request() {
        let network = Network::new(ServerConfig::load_default_for_tests());
        let key = ambra_net::Identity::generate().unwrap().public_key();
        network.pending.lock().await.insert("handle".into(), PendingPairing {
            code: "123456".into(), client_id: "client".into(), client_name: "Device".into(), peer: "test".into(), requested: Instant::now(), token: None, denied: false, client_key: Some(key),
        });
        let peer = |key| Some(axum::Extension(ambra_net::transport::RemotePeer { public_key: key, address: "127.0.0.1:1".parse().unwrap(), session: Arc::new(()) }));
        let stranger = ambra_net::Identity::generate().unwrap().public_key();
        assert_eq!(pairing_status(State(network.clone()), Path("handle".into()), peer(stranger)).await.status(), StatusCode::FORBIDDEN);
        assert!(network.pending.lock().await.contains_key("handle"));
        network.pending.lock().await.get_mut("handle").unwrap().requested = Instant::now() - PAIRING_EXPIRES;
        let response = pairing_status(State(network.clone()), Path("handle".into()), peer(key)).await;
        let bytes = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["status"], "expired");
        assert!(network.pending.lock().await.is_empty());
    }
}
