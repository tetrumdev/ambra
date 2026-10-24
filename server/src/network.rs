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
}

pub struct Network {
    pub config: RwLock<ServerConfig>,
    pending: Mutex<HashMap<String, PendingPairing>>,
    /// The address actually listened on, which an environment override may have changed.
    pub listening: RwLock<Option<SocketAddr>>,
}

pub type SharedNetwork = Arc<Network>;

impl Network {
    pub fn new(config: ServerConfig) -> SharedNetwork {
        Arc::new(Self {
            config: RwLock::new(config),
            pending: Mutex::new(HashMap::new()),
            listening: RwLock::new(None),
        })
    }

    pub fn is_paired_token(&self, token: &str) -> bool {
        self.config
            .read()
            .map(|config| config.client_for_token(token).is_some())
            .unwrap_or(false)
    }

    fn update(&self, change: impl FnOnce(&mut ServerConfig) -> Result<(), String>) -> Result<ServerConfig, String> {
        let mut config = self.config.write().map_err(|_| "Server settings are unavailable")?;
        let mut next = config.clone();
        change(&mut next)?;
        next.save()?;
        *config = next.clone();
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
        .route("/api/pair/request", post(request_pairing))
        .route("/api/pair/request/{request_id}", get(pairing_status))
        .with_state(network)
}

/// Routes only the server machine may call (see `access::LOCAL_ONLY_PREFIX`).
pub fn local_router<S: Clone + Send + Sync + 'static>(network: SharedNetwork) -> Router<S> {
    Router::new()
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
    Json(request): Json<PairingRequest>,
) -> Response {
    if !valid_client_field(&request.client_id, 64) || !valid_client_field(&request.client_name, 64) {
        return error(StatusCode::BAD_REQUEST, "A client ID and name of at most 64 characters are required");
    }
    let mut pending = network.pending.lock().await;
    expire(&mut pending);
    // A client asking again replaces its earlier request, so retries don't fill the list.
    pending.retain(|_, pairing| pairing.client_id != request.client_id);
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
        },
    );
    Json(json!({ "requestId": request_id, "code": code, "expiresInSeconds": PAIRING_EXPIRES.as_secs() })).into_response()
}

async fn pairing_status(State(network): State<SharedNetwork>, Path(request_id): Path<String>) -> Response {
    let mut pending = network.pending.lock().await;
    expire(&mut pending);
    let Some(pairing) = pending.get(&request_id).cloned() else {
        return Json(json!({ "status": "expired" })).into_response();
    };
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
