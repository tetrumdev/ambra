//! Optional connection to an independently running, cryptographically paired Ambra server.
//! The legacy "host" setting is retained on disk for compatibility and now means local-only.
//!
//! The app never automatically starts or falls back to another server. An unavailable selected
//! server remains selected until the listener chooses another one.

use std::{
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const FILE_NAME: &str = "server-link.json";


#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Host,
    Join,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WhenAway {
    /// Stay a remote of the joined server and reconnect when it's back.
    #[default]
    Wait,
    /// Accepted only for compatibility with old saved settings; no longer used.
    Fallback,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinedServer {
    pub id: String,
    pub name: String,
    /// `host:port`, as discovered or typed.
    pub address: String,
    #[serde(default)]
    pub public_key: Option<ambra_net::PublicKey>,
    #[serde(default)]
    pub local_addresses: Vec<SocketAddr>,
    #[serde(default)]
    pub public_endpoint: Option<SocketAddr>,
    #[serde(default)]
    pub public_tcp: Vec<SocketAddr>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    mode: Mode,
    /// Whether the listener has answered the first-run "join the server on your network?" offer.
    #[serde(default)]
    decided: bool,
    #[serde(default)]
    server: Option<JoinedServer>,
    #[serde(default)]
    token: Option<String>,
    client_id: String,
    #[serde(default)]
    when_away: WhenAway,
    /// Every server this device has paired with, so the listener can move between them
    /// (home, a friend's) without pairing again. `server` and `token` are the selected one.
    #[serde(default)]
    saved: Vec<SavedServer>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedServer {
    server: JoinedServer,
    token: String,
}

/// A paired server as the app's screens see it; its token never leaves this process.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedServerSummary {
    pub id: String,
    pub name: String,
    pub address: String,
    pub public_key: Option<ambra_net::PublicKey>,
    pub selected: bool,
}

impl Settings {
    fn new() -> Self {
        let mut id = [0_u8; 16];
        getrandom::fill(&mut id).expect("the operating system's random source is available");
        Self {
            mode: Mode::Host,
            decided: false,
            server: None,
            token: None,
            client_id: id.iter().map(|byte| format!("{byte:02x}")).collect(),
            when_away: WhenAway::Wait,
            saved: Vec::new(),
        }
    }

    /// Keeps the selected server in the saved list, replacing an older pairing with the same server.
    fn remember_selected(&mut self) {
        let (Some(server), Some(token)) = (self.server.clone(), self.token.clone()) else { return };
        let Some(key) = server.public_key else { return };
        let entry = SavedServer { server, token };
        match self.saved.iter_mut().find(|saved| saved.server.public_key == Some(key)) {
            Some(saved) => *saved = entry,
            None => self.saved.push(entry),
        }
    }

    fn load(directory: &Path) -> Self {
        std::fs::read(directory.join(FILE_NAME))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            // A joined link without its server or token is unusable; start over as a host.
            .filter(|settings| settings.mode == Mode::Host || (settings.server.is_some() && settings.token.is_some()))
            .map(|mut settings| {
                // Settings written before servers were saved hold only the selected one.
                settings.remember_selected();
                settings
            })
            .unwrap_or_else(Self::new)
    }

    fn save(&self, directory: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        write_private(&directory.join(FILE_NAME), &bytes)
    }
}

/// The current optional server connection, independent of the local player.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub mode: Mode,
    pub base_url: String,
    pub token: Option<String>,
    /// Joined, but using this machine's own server because the joined one was away.
    pub fallback: bool,
    pub server: Option<JoinedServer>,
    pub when_away: WhenAway,
    pub decided: bool,
    pub client_name: String,
    /// This app's ID on the server, under which its outputs appear to other devices.
    pub client_id: String,
}

pub struct ServerLink {
    directory: PathBuf,
    settings: Mutex<Settings>,
    runtime: Mutex<Runtime>,
    pub transition: tokio::sync::Mutex<()>,
    pairing: Mutex<Pairing>,
}

struct Runtime {
    connection: Connection,
    manager: Option<Arc<ambra_net::ConnectionManager>>,
    bridge: Option<ambra_net::bridge::Bridge>,
    network_error: Option<String>,
}

#[derive(Default)]
struct Pairing { generation: u64, session: Option<PairingSession> }
struct PairingSession { address: String, request_id: String, payload: ambra_net::pairing::PairingPayload, manager: Option<Arc<ambra_net::ConnectionManager>>, approved: Option<(JoinedServer, String)> }

impl Drop for PairingSession {
    fn drop(&mut self) {
        if let Some(manager) = self.manager.take() {
            manager.cancel.cancel();
            tauri::async_runtime::spawn(async move { manager.shutdown().await; });
        }
    }
}

pub fn client_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|output| String::from_utf8(output.stdout).ok())
        })
        .map(|name| name.trim().trim_end_matches(".local").chars().take(64).collect::<String>())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Ambra".into())
}

impl ServerLink {
    /// Reads the saved choice without starting a server or changing it when offline.
    pub fn start(directory: PathBuf) -> Result<Self, String> {
        let settings = Settings::load(&directory);
        let runtime = tauri::async_runtime::block_on(Runtime::prepare(&directory, &settings, None));
        // A saved server can be unavailable without preventing local startup.
        let runtime = runtime.unwrap_or_else(|error| Runtime {
            connection: Self::describe(&settings, None), manager: None, bridge: None, network_error: Some(error),
        });
        Ok(Self { directory, settings: Mutex::new(settings), runtime: Mutex::new(runtime), transition: tokio::sync::Mutex::new(()), pairing: Mutex::new(Pairing::default()) })
    }

    fn describe(settings: &Settings, bridge: Option<&ambra_net::bridge::Bridge>) -> Connection {
        Connection {
            mode: settings.mode,
            base_url: bridge.map(|bridge| bridge.base_url.clone()).unwrap_or_else(|| "http://127.0.0.1:9".into()),
            token: None, fallback: false, server: settings.server.clone(), when_away: WhenAway::Wait,
            decided: settings.decided, client_name: client_name(), client_id: settings.client_id.clone(),
        }
    }

    // Caller serializes selection changes with shared-output ownership changes.
    async fn install(&self, next: Settings, app: Option<&tauri::AppHandle>, enrollment: Option<Arc<ambra_net::ConnectionManager>>) -> Result<(), String> {
        let runtime = Runtime::prepare(&self.directory, &next, enrollment).await?;
        next.save(&self.directory)?;
        // Preparation and persistence can fail; keep the previous output alive until both succeed.
        if let Some(app) = app { crate::remote_endpoint::stop_shared_output(app).await; }
        let previous = {
            let mut settings = self.settings.lock().map_err(|_| "Server settings are unavailable")?;
            let mut current = self.runtime.lock().map_err(|_| "Server connection is unavailable")?;
            *settings = next;
            std::mem::replace(&mut *current, runtime)
        };
        if let Some(bridge) = previous.bridge { bridge.shutdown().await; }
        Ok(())
    }

    fn cancel_pairing(&self) -> Result<u64, String> {
        let mut pending = self.pairing.lock().map_err(|_| "Pairing unavailable")?;
        pending.generation += 1;
        pending.session.take();
        Ok(pending.generation)
    }

    async fn join(&self, request_id: &str, app: Option<&tauri::AppHandle>) -> Result<(), String> {
        let _transition = self.transition.lock().await;
        let (server, token, manager) = {
            let pending = self.pairing.lock().map_err(|_| "Pairing unavailable")?;
            let session = pending.session.as_ref().filter(|session| session.request_id == request_id).ok_or("Pairing is not approved")?;
            let (server, token) = session.approved.clone().ok_or("Pairing is not approved")?;
            (server, token, session.manager.clone().ok_or("Pairing already joined")?)
        };
        manager.authorize(token.clone()).await.map_err(|e| e.to_string())?;
        let mut next = self.settings.lock().map_err(|_| "Server settings are unavailable")?.clone();
        next.mode = Mode::Join; next.decided = true; next.server = Some(server); next.token = Some(token);
        next.remember_selected();
        self.install(next, app, Some(manager)).await?;
        // Ownership moved into the joined runtime; dropping enrollment must not close it.
        if let Some(session) = self.pairing.lock().map_err(|_| "Pairing unavailable")?.session.as_mut() { session.manager.take(); }
        self.cancel_pairing()?;
        Ok(())
    }

    fn change(&self, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
        let mut settings = self.settings.lock().map_err(|_| "Server settings are unavailable")?;
        let mut next = settings.clone();
        change(&mut next);
        next.save(&self.directory)?;
        self.runtime.lock().map_err(|_| "Server connection is unavailable")?.connection.decided = next.decided;
        *settings = next;
        Ok(())
    }

    pub fn connection(&self) -> Connection {
        self.runtime.lock().expect("server connection lock").connection.clone()
    }

    pub fn client_id(&self) -> String {
        self.settings.lock().map(|settings| settings.client_id.clone()).unwrap_or_default()
    }

    #[cfg(debug_assertions)]
    pub async fn reconnect_for_test(&self) -> Result<(), String> {
        let manager = self.runtime.lock().unwrap().manager.clone().ok_or("No server transport")?;
        manager.connect().await.map_err(|error| error.to_string())?.close();
        Ok(())
    }
}

impl Runtime {
    async fn prepare(directory: &Path, settings: &Settings, enrollment: Option<Arc<ambra_net::ConnectionManager>>) -> Result<Self, String> {
        let (manager, bridge) = if settings.mode == Mode::Join {
            let server = settings.server.as_ref().ok_or("Missing server")?;
            let public_key = server.public_key.ok_or("Legacy pairing has no cryptographic identity. Pair again using the server QR link.")?;
            let identity = ambra_net::Identity::load_or_create(&directory.join("client-network-identity.key")).map_err(|e| e.to_string())?;
            let selected = ambra_net::SelectedServer { public_key, local_addresses: server.local_addresses.clone(), public_endpoint: server.public_endpoint, public_tcp: server.public_tcp.clone() };
            let manager = enrollment.unwrap_or_else(|| ambra_net::ConnectionManager::new(identity, selected, settings.token.clone()));
            // Remembers the server's public address learned at home, for use away from it.
            manager.use_endpoint_cache(endpoint_cache(directory, &public_key));
            // Like the phone: a warm Internet path beside the LAN, network changes noticed at
            // once, and songs downloaded ahead, so moving between LAN and P2P never stops a song.
            manager.enable_roaming();
            manager.watch_network();
            let cache = directory.join("network-media-cache");
            let bridge = ambra_net::bridge::Bridge::start_with_cache(manager.clone(), Some(cache)).await.map_err(|e| e.to_string())?;
            (Some(manager), Some(bridge))
        } else { (None, None) };
        Ok(Self { connection: ServerLink::describe(settings, bridge.as_ref()), manager, bridge, network_error: None })
    }
}

/// Each saved server remembers its own public addresses, so switching between them loses neither.
fn endpoint_cache(directory: &Path, public_key: &ambra_net::PublicKey) -> PathBuf {
    let path = directory.join("server-endpoints").join(format!("{public_key}.json"));
    if !path.exists() {
        // The single cache of earlier versions; it names its server, so a mismatch is ignored.
        let legacy = directory.join("server-endpoints.json");
        if legacy.exists() && std::fs::create_dir_all(path.parent().expect("has a parent")).is_ok() {
            let _ = std::fs::copy(legacy, &path);
        }
    }
    path
}

#[tauri::command]
pub fn server_connection(link: tauri::State<'_, ServerLink>) -> Connection {
    link.connection()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    pub id: String,
    pub name: String,
    pub version: String,
    pub address: String,
}

#[tauri::command]
pub async fn discover_servers(timeout_ms: Option<u64>) -> Result<Vec<DiscoveredServer>, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(1500).clamp(200, 10_000));
    Ok(ambra_net::lan::discover(timeout).await.map_err(|e| e.to_string())?.into_iter().map(|server| DiscoveredServer {
        id: server.info.id, name: server.info.name, version: server.info.version,
        address: SocketAddr::new(server.address.ip(), server.info.port).to_string(),
    }).collect())
}

/// The connection's status. Given the status the app last saw (`known`), it answers as soon
/// as that changes, or after `wait_ms`: the app hears of a connection the moment it's made,
/// rather than at its next look.
#[tauri::command]
pub async fn network_connection_status(link: tauri::State<'_, ServerLink>, known: Option<Value>, wait_ms: Option<u64>) -> Result<Value, String> {
    let manager = link.runtime.lock().map_err(|_| "Server connection is unavailable")?.manager.clone();
    if let (Some(manager), Some(known)) = (manager, known) {
        let mut status = manager.subscribe();
        let wait = Duration::from_millis(wait_ms.unwrap_or(3000).min(30_000));
        let _ = tokio::time::timeout(wait, async {
            loop {
                let current = serde_json::to_value(&*status.borrow_and_update()).unwrap_or(Value::Null);
                if current != known || status.changed().await.is_err() { return; }
            }
        }).await;
    }
    Ok(current_network_status(&link))
}

pub fn current_network_status(link: &ServerLink) -> Value {
    let runtime = link.runtime.lock().expect("server connection lock");
    runtime.manager.as_ref().map(|m| serde_json::to_value(m.status()).unwrap_or(Value::Null)).unwrap_or_else(|| {
        json!({ "state": if runtime.connection.mode == Mode::Join { "Failed" } else { "Offline" },
            "error": runtime.network_error })
    })
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().ok_or("Missing settings directory")?).map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new(); options.write(true).create(true).truncate(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    use std::io::Write;
    let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    drop(file); std::fs::rename(temporary, path).map_err(|e| e.to_string())
}

/// `host[:port]`, with Ambra's port when none is given.
fn normalize_address(address: &str) -> Result<String, String> {
    let address = address.trim().trim_start_matches("http://").trim_end_matches('/');
    if address.is_empty() || address.contains(['/', ' ', '@']) {
        return Err("Enter the server's address, such as 192.168.1.20".into());
    }
    let with_port = match address.parse::<IpAddr>() {
        Ok(IpAddr::V6(ip)) => format!("[{ip}]:38147"),
        Ok(IpAddr::V4(ip)) => format!("{ip}:38147"),
        Err(_) if address.rsplit_once(':').is_some_and(|(_, port)| port.parse::<u16>().is_ok()) => address.to_owned(),
        Err(_) => format!("{address}:38147"),
    };
    Ok(with_port)
}

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())
}

fn answer(response: reqwest::blocking::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response.json::<Value>().unwrap_or(Value::Null);
    if status.is_success() {
        Ok(body)
    } else {
        Err(body["error"].as_str().map_or_else(|| format!("The server answered {status}"), str::to_owned))
    }
}

fn pairing_addresses(address: &str) -> Result<Vec<SocketAddr>, String> {
    use std::net::ToSocketAddrs;
    let addresses: Vec<_> = address.to_socket_addrs().map_err(|e| e.to_string())?
        .filter(|a| ambra_net::lan::is_direct(a.ip())).collect();
    if addresses.is_empty() {
        return Err("Manual pairing requires a LAN or Tailscale address; use the server pairing link across networks".into());
    }
    Ok(addresses)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStarted {
    request_id: String,
    code: String,
    address: String,
    server_name: String,
}

async fn pairing_target(address: &str) -> Result<ambra_net::pairing::PairingPayload, String> {
    let payload = if address.starts_with("ambra://pair/") {
        ambra_net::pairing::PairingPayload::decode(address).map_err(|e| e.to_string())?
    } else {
        let address = normalize_address(address)?;
        // Manual bootstrap exchanges public hints only; approval verifies the pinned key.
        tauri::async_runtime::spawn_blocking(move || {
            let addresses = pairing_addresses(&address)?;
            let endpoint = &addresses[0];
            let info = http()?.get(format!("http://{endpoint}/api/server/info")).send().map_err(|e| e.to_string()).and_then(answer)?;
            let public_key = serde_json::from_value(info["publicKey"].clone()).map_err(|_| "Server needs an update before encrypted pairing")?;
            let port = info["securePort"].as_u64().and_then(|p| u16::try_from(p).ok()).ok_or("Secure listener unavailable")?;
            let local_addresses = addresses.into_iter()
                .map(|a| SocketAddr::new(a.ip(), port)).collect();
            Ok::<_, String>(ambra_net::pairing::PairingPayload { version: 1, public_key, name: info["name"].as_str().unwrap_or("Ambra").into(), local_addresses, public_endpoint: None, public_tcp: vec![] })
        }).await.map_err(|e| e.to_string())??
    };
    Ok(payload)
}

#[tauri::command]
pub async fn start_pairing(link: tauri::State<'_, ServerLink>, address: String) -> Result<PairingStarted, String> {
    let generation = { let _transition = link.transition.lock().await; link.cancel_pairing()? };
    let payload = pairing_target(&address).await?;
    let identity = ambra_net::Identity::load_or_create(&link.directory.join("client-network-identity.key")).map_err(|e| e.to_string())?;
    let selected = ambra_net::SelectedServer { public_key: payload.public_key, local_addresses: payload.local_addresses.clone(), public_endpoint: payload.public_endpoint, public_tcp: payload.public_tcp.clone() };
    let manager = ambra_net::ConnectionManager::new(identity, selected, None);
    manager.use_endpoint_cache(endpoint_cache(&link.directory, &payload.public_key));
    let mut session = PairingSession { address: address.clone(), request_id: String::new(), payload: payload.clone(), manager: Some(manager.clone()), approved: None };
    let started = manager.json("POST", "/api/pair/request", Some(json!({ "clientId": link.client_id(), "clientName": client_name() }))).await.map_err(|e| e.to_string())?;
    let request_id = started["requestId"].as_str().ok_or("Missing pairing handle")?.to_owned();
    let result = PairingStarted { request_id: request_id.clone(), code: started["code"].as_str().ok_or("Missing pairing code")?.into(), address: address.clone(), server_name: payload.name.clone() };
    let mut pending = link.pairing.lock().map_err(|_| "Pairing unavailable")?;
    if pending.generation != generation { return Err("Pairing cancelled".into()); }
    session.request_id = request_id;
    pending.session = Some(session);
    Ok(result)
}

#[tauri::command]
pub async fn poll_pairing(link: tauri::State<'_, ServerLink>, address: String, request_id: String) -> Result<String, String> {
    let (manager, payload, generation) = {
        let pending = link.pairing.lock().map_err(|_| "Pairing unavailable")?;
        let session = pending.session.as_ref().filter(|s| s.address == address && s.request_id == request_id).ok_or("Start pairing again")?;
        (session.manager.clone().ok_or("Pairing already joined")?, session.payload.clone(), pending.generation)
    };
    let reply = manager.json("GET", &format!("/api/pair/request/{request_id}"), None).await.map_err(|e| e.to_string())?;
    let status = reply["status"].as_str().unwrap_or("expired").to_owned();
    if status == "approved" {
        let token = reply["token"].as_str().ok_or("The server approved but sent no token")?.to_owned();
        let server = JoinedServer {
            id: reply["server"]["id"].as_str().unwrap_or_default().into(), name: payload.name,
            address: payload.local_addresses.first().map(|a| a.to_string()).unwrap_or_else(|| payload.public_key.to_string()),
            public_key: Some(payload.public_key), local_addresses: payload.local_addresses, public_endpoint: payload.public_endpoint,
            public_tcp: payload.public_tcp,
        };
        let mut pending = link.pairing.lock().map_err(|_| "Pairing unavailable")?;
        if pending.generation != generation { return Err("Pairing cancelled".into()); }
        let session = pending.session.as_mut().ok_or("Start pairing again")?;
        session.approved = Some((server, token));
    }
    Ok(status)
}

#[tauri::command]
pub async fn cancel_pairing(link: tauri::State<'_, ServerLink>, request_id: String) -> Result<(), String> {
    let _transition = link.transition.lock().await;
    let mut pending = link.pairing.lock().map_err(|_| "Pairing unavailable")?;
    if pending.session.as_ref().is_some_and(|session| session.request_id == request_id) {
        pending.generation += 1;
        pending.session.take();
    }
    Ok(())
}

#[tauri::command]
pub async fn join_server(app: tauri::AppHandle, link: tauri::State<'_, ServerLink>, request_id: String) -> Result<(), String> {
    link.join(&request_id, Some(&app)).await
}

/// Disconnect the client without touching any device or server data. The server stays saved.
#[tauri::command]
pub async fn leave_server(app: tauri::AppHandle, link: tauri::State<'_, ServerLink>) -> Result<(), String> {
    let _transition = link.transition.lock().await;
    link.cancel_pairing()?;
    let mut next = link.settings.lock().map_err(|_| "Server settings are unavailable")?.clone();
    next.mode = Mode::Host; next.decided = true; next.server = None; next.token = None;
    link.install(next, Some(&app), None).await
}

/// The first-run offer to join a server on the network was answered or dismissed.
#[tauri::command]
pub async fn set_server_link_decided(link: tauri::State<'_, ServerLink>) -> Result<(), String> {
    let _transition = link.transition.lock().await;
    link.change(|settings| settings.decided = true)
}

#[tauri::command]
pub fn saved_servers(link: tauri::State<'_, ServerLink>) -> Result<Vec<SavedServerSummary>, String> {
    let settings = link.settings.lock().map_err(|_| "Server settings are unavailable")?;
    let selected = settings.server.as_ref().filter(|_| settings.mode == Mode::Join).and_then(|server| server.public_key);
    Ok(settings.saved.iter().map(|saved| SavedServerSummary {
        id: saved.server.id.clone(),
        name: saved.server.name.clone(),
        address: saved.server.address.clone(),
        public_key: saved.server.public_key,
        selected: saved.server.public_key.is_some() && saved.server.public_key == selected,
    }).collect())
}

/// Connects to a server paired earlier, using the token it gave this device then.
#[tauri::command]
pub async fn connect_saved_server(app: tauri::AppHandle, link: tauri::State<'_, ServerLink>, public_key: ambra_net::PublicKey) -> Result<(), String> {
    let _transition = link.transition.lock().await;
    link.cancel_pairing()?;
    let mut next = link.settings.lock().map_err(|_| "Server settings are unavailable")?.clone();
    let saved = next.saved.iter().find(|saved| saved.server.public_key == Some(public_key)).cloned()
        .ok_or("That server is no longer saved")?;
    next.mode = Mode::Join; next.decided = true; next.server = Some(saved.server); next.token = Some(saved.token);
    link.install(next, Some(&app), None).await
}

/// Forgets a saved server's pairing on this device, disconnecting first if it is the selected one.
#[tauri::command]
pub async fn forget_saved_server(app: tauri::AppHandle, link: tauri::State<'_, ServerLink>, public_key: ambra_net::PublicKey) -> Result<(), String> {
    let _transition = link.transition.lock().await;
    let mut next = link.settings.lock().map_err(|_| "Server settings are unavailable")?.clone();
    next.saved.retain(|saved| saved.server.public_key != Some(public_key));
    let selected = next.server.as_ref().is_some_and(|server| server.public_key == Some(public_key));
    if selected {
        link.cancel_pairing()?;
        next.mode = Mode::Host; next.server = None; next.token = None;
        link.install(next, Some(&app), None).await
    } else {
        link.change(|settings| settings.saved = next.saved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn manual_bootstrap_and_address_free_pairing_links_preserve_the_server_key() {
        use std::io::{Read, Write};
        let identity = ambra_net::Identity::generate().unwrap();
        let key = identity.public_key();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let responder = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 1024]; let _ = socket.read(&mut request).unwrap();
            let body = json!({ "publicKey": key, "securePort": 40000, "name": "Independent server" }).to_string();
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let manual = pairing_target(&address.to_string()).await.unwrap();
        assert_eq!(manual.public_key, key);
        assert_eq!(manual.local_addresses, vec!["127.0.0.1:40000".parse::<SocketAddr>().unwrap()]);
        responder.join().unwrap();
        let public_link = ambra_net::pairing::PairingPayload { version: 1, public_key: key, name: "Remote".into(), local_addresses: vec![], public_endpoint: None, public_tcp: vec![] }.encode().unwrap();
        let remote = pairing_target(&public_link).await.unwrap();
        assert_eq!(remote.public_key, key);
        assert!(remote.local_addresses.is_empty());
        assert!(remote.public_endpoint.is_none());
    }

    #[test]
    fn paired_servers_stay_saved_across_upgrades_repairs_and_disconnects() {
        let directory = std::env::temp_dir().join(format!("ambra-saved-servers-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let key = ambra_net::Identity::generate().unwrap().public_key();
        let server = |name: &str| JoinedServer { id: name.into(), name: name.into(), address: "127.0.0.1:9".into(), public_key: Some(key), local_addresses: vec![], public_endpoint: None, public_tcp: vec![] };
        // Written before servers were saved: only the selected one, with no list.
        let mut legacy = serde_json::to_value(Settings::new()).unwrap();
        legacy["mode"] = json!("join");
        legacy["server"] = serde_json::to_value(server("Home")).unwrap();
        legacy["token"] = json!("old-token");
        legacy.as_object_mut().unwrap().remove("saved");
        std::fs::write(directory.join(FILE_NAME), serde_json::to_vec(&legacy).unwrap()).unwrap();
        let mut settings = Settings::load(&directory);
        assert_eq!(settings.saved, vec![SavedServer { server: server("Home"), token: "old-token".into() }]);
        // Pairing with the same server again replaces its entry rather than adding another.
        settings.server = Some(server("Home renamed"));
        settings.token = Some("new-token".into());
        settings.remember_selected();
        assert_eq!(settings.saved, vec![SavedServer { server: server("Home renamed"), token: "new-token".into() }]);
        // Disconnecting clears the selection only.
        settings.mode = Mode::Host; settings.server = None; settings.token = None;
        settings.save(&directory).unwrap();
        assert_eq!(Settings::load(&directory).saved.len(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn an_unconfigured_client_starts_offline_without_a_server() {
        let directory = std::env::temp_dir().join(format!("ambra-unconfigured-{}", std::process::id()));
        let link = ServerLink::start(directory).unwrap();
        assert!(link.connection().server.is_none());
        assert!(link.runtime.lock().unwrap().manager.is_none());
        assert!(link.runtime.lock().unwrap().bridge.is_none());
        assert_eq!(link.connection().base_url, "http://127.0.0.1:9");
    }

    #[test]
    fn runtime_switches_release_old_bridges_and_preserve_device_state() {
        let directory = std::env::temp_dir().join(format!("ambra-runtime-{}", std::process::id()));
        let link = ServerLink::start(directory.clone()).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        let local = directory.join("persistent-state.json");
        std::fs::write(&local, b"private playlists, queue, playback and settings").unwrap();
        let initial = link.settings.lock().unwrap().clone();
        tauri::async_runtime::block_on(async {
            let keys = [ambra_net::Identity::generate().unwrap().public_key(), ambra_net::Identity::generate().unwrap().public_key()];
            let mut previous: Option<(String, Arc<ambra_net::ConnectionManager>)> = None;
            for index in 0..6 {
                let mut next = initial.clone();
                if index % 3 != 2 {
                    next.mode = Mode::Join;
                    next.server = Some(JoinedServer { id: index.to_string(), name: "Independent".into(), address: "127.0.0.1:9".into(), public_key: Some(keys[index % 2]), local_addresses: vec![], public_endpoint: None, public_tcp: vec![] });
                    next.token = Some(format!("token-{index}"));
                }
                link.install(next, None, None).await.unwrap();
                if let Some((url, manager)) = previous.take() {
                    assert!(manager.cancel.is_cancelled());
                    assert_eq!(manager.status().state, ambra_net::ConnectionState::Offline);
                    let address = url.strip_prefix("http://").unwrap().split('/').next().unwrap();
                    assert!(tokio::net::TcpStream::connect(address).await.is_err(), "old bridge still accepts connections");
                    assert!(manager.connect().await.is_err());
                }
                let connection = link.connection();
                assert_eq!(connection.client_id, initial.client_id);
                assert!(connection.token.is_none(), "the bridge must keep authentication private");
                let runtime = link.runtime.lock().unwrap();
                if let Some(manager) = &runtime.manager {
                    assert_eq!(connection.server.as_ref().unwrap().public_key, Some(keys[index % 2]));
                    previous = Some((connection.base_url, manager.clone()));
                } else {
                    assert_eq!(connection.mode, Mode::Host);
                    assert!(runtime.bridge.is_none());
                    assert!(connection.server.is_none());
                    assert!(link.settings.lock().unwrap().token.is_none());
                }
            }
        });
        assert_eq!(std::fs::read(&local).unwrap(), b"private playlists, queue, playback and settings");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_switches_keep_the_current_connection_and_saved_selection() {
        let directory = std::env::temp_dir().join(format!("ambra-switch-failure-{}", std::process::id()));
        let link = ServerLink::start(directory.clone()).unwrap();
        let initial = link.settings.lock().unwrap().clone();
        tauri::async_runtime::block_on(async {
            let mut next = initial.clone();
            next.mode = Mode::Join;
            next.server = Some(JoinedServer { id: "bad".into(), name: "Legacy".into(), address: "127.0.0.1:9".into(), public_key: None, local_addresses: vec![], public_endpoint: None, public_tcp: vec![] });
            next.token = Some("secret".into());
            assert!(link.install(next.clone(), None, None).await.is_err());
            assert_eq!(link.connection().mode, Mode::Host);
            next.server.as_mut().unwrap().public_key = Some(ambra_net::Identity::generate().unwrap().public_key());
            // A settings write failure must not partially commit the prepared bridge.
            std::fs::create_dir_all(directory.join(FILE_NAME)).unwrap();
            assert!(link.install(next, None, None).await.is_err());
            assert_eq!(link.connection().mode, Mode::Host);
            assert_eq!(link.settings.lock().unwrap().client_id, initial.client_id);
            assert!(link.settings.lock().unwrap().token.is_none());
        });
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn addresses_get_ambras_port() {
        assert_eq!(normalize_address("192.168.1.20").unwrap(), "192.168.1.20:38147");
        assert_eq!(normalize_address("http://10.0.0.5:9000/").unwrap(), "10.0.0.5:9000");
        assert_eq!(normalize_address("ambra-core.local").unwrap(), "ambra-core.local:38147");
        assert_eq!(normalize_address("fe80::1").unwrap(), "[fe80::1]:38147");
        assert!(normalize_address("").is_err());
        assert!(normalize_address("evil.com/x").is_err());
    }

    #[test]
    fn a_join_without_credentials_starts_over_as_host() {
        let directory = std::env::temp_dir().join(format!("ambra-link-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(FILE_NAME), br#"{"mode":"join","clientId":"abc"}"#).unwrap();
        assert_eq!(Settings::load(&directory).mode, Mode::Host);
        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn an_unavailable_joined_server_is_kept_even_with_an_old_fallback_preference() {
        let directory = std::env::temp_dir().join(format!("ambra-link-wait-{}", std::process::id()));
        let mut settings = Settings::new();
        settings.mode = Mode::Join;
        settings.when_away = WhenAway::Fallback;
        settings.server = Some(JoinedServer { id: "core".into(), name: "Music server".into(), address: "127.0.0.1:9".into(), public_key: None, local_addresses: vec![], public_endpoint: None, public_tcp: vec![] });
        settings.token = Some("paired-token".into());
        settings.save(&directory).unwrap();
        let connection = ServerLink::start(directory.clone()).unwrap().connection();
        assert_eq!(connection.base_url, "http://127.0.0.1:9");
        assert_eq!(connection.token, None);
        assert!(!connection.fallback);
        assert_eq!(connection.when_away, WhenAway::Wait);
        std::fs::remove_file(directory.join(FILE_NAME)).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}

#[cfg(test)]
mod pairing_handoff_tests {
    use super::*;

    #[test]
    fn approved_pairing_transfers_the_manager_without_cancelling_it() {
        let directory = std::env::temp_dir().join(format!("ambra-handoff-{}", std::process::id()));
        let link = ServerLink::start(directory.clone()).unwrap();
        tauri::async_runtime::block_on(async {
            let server = ambra_net::Identity::generate().unwrap();
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let cancel = tokio_util::sync::CancellationToken::new();
            let app = axum::Router::new().route("/api/network/session", axum::routing::get(|request: axum::extract::Request| async move {
                if request.headers().get("authorization").is_some_and(|v| v == "Bearer paired-token") { axum::http::StatusCode::OK } else { axum::http::StatusCode::UNAUTHORIZED }
            }));
            let task = tokio::spawn(ambra_net::lan::serve(listener, server.clone(), app, ambra_net::gate::admit_all(), cancel.clone()));
            let payload = ambra_net::pairing::PairingPayload { version: 1, public_key: server.public_key(), name: "Independent".into(), local_addresses: vec![address], public_endpoint: None, public_tcp: vec![] };
            let manager = ambra_net::ConnectionManager::new(ambra_net::Identity::generate().unwrap(), ambra_net::SelectedServer { public_key: payload.public_key, local_addresses: vec![address], public_endpoint: None, public_tcp: vec![] }, None);
            let connection = manager.connect().await.unwrap();
            let joined = JoinedServer { id: "independent".into(), name: payload.name.clone(), address: address.to_string(), public_key: Some(payload.public_key), local_addresses: vec![address], public_endpoint: None, public_tcp: vec![] };
            link.pairing.lock().unwrap().session = Some(PairingSession { address: payload.encode().unwrap(), request_id: "approved".into(), payload, manager: Some(manager.clone()), approved: Some((joined, "paired-token".into())) });
            link.join("approved", None).await.unwrap();
            assert!(!manager.cancel.is_cancelled());
            assert!(link.pairing.lock().unwrap().session.is_none());
            assert!(Arc::ptr_eq(link.runtime.lock().unwrap().manager.as_ref().unwrap(), &manager));
            assert!(Arc::ptr_eq(&connection, &manager.connect().await.unwrap()));
            assert_eq!(manager.status().state, ambra_net::ConnectionState::ConnectedLocal);
            let bridge = link.runtime.lock().unwrap().bridge.take().unwrap();
            bridge.shutdown().await;
            cancel.cancel();
            task.await.unwrap().unwrap();
        });
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn manual_pairing_rejects_public_addresses_before_bootstrap_http() {
        for address in ["8.8.8.8", "[2606:4700:4700::1111]:38147"] {
            let error = pairing_target(address).await.unwrap_err();
            assert!(error.contains("LAN or Tailscale address"), "{error}");
        }
    }

    #[test]
    fn manual_pairing_accepts_tailscale_addresses() {
        for address in ["100.106.252.60", "[fd7a:115c:a1e0::f537:fc3d]:38147"] {
            let address = normalize_address(address).unwrap();
            assert_eq!(pairing_addresses(&address).unwrap(), vec![address.parse::<SocketAddr>().unwrap()]);
        }
    }
}
