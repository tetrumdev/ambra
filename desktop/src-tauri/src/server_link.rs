//! Which Ambra server this app uses: one already running locally ("host"), or one elsewhere on
//! the network that it has paired with ("join").
//!
//! The app never automatically starts or falls back to another server. An unavailable selected
//! server remains selected until the listener chooses another one.

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::Manager;

const FILE_NAME: &str = "server-link.json";
const DISCOVERY_PORT: u16 = 38148;
const DISCOVERY_REQUEST: &[u8] = b"AMBRA-DISCOVER/1";
const LOCAL_SERVER: &str = "127.0.0.1:38147";

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
        }
    }

    fn load(directory: &Path) -> Self {
        std::fs::read(directory.join(FILE_NAME))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok())
            // A joined link without its server or token is unusable; start over as a host.
            .filter(|settings| settings.mode == Mode::Host || (settings.server.is_some() && settings.token.is_some()))
            .unwrap_or_else(Self::new)
    }

    fn save(&self, directory: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        crate::write_file_atomic(&directory.join(FILE_NAME), &bytes)
    }
}

/// What the webview needs to talk to the server, fixed for this run of the app.
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
    connection: Connection,
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

fn local_base_url(directory: &Path) -> String {
    let recorded = std::fs::read(directory.join("server-runtime.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["address"].as_str()?.parse::<SocketAddr>().ok());
    let address = std::env::var("AMBRA_SERVER_ADDRESS")
        .ok()
        .and_then(|address| address.parse::<SocketAddr>().ok())
        .or(recorded)
        .map_or_else(|| LOCAL_SERVER.to_owned(), |address| format!("127.0.0.1:{}", address.port()));
    format!("http://{address}")
}

impl ServerLink {
    /// Reads the saved choice without starting a server or changing it when offline.
    pub fn start(directory: PathBuf) -> Self {
        let settings = Settings::load(&directory);
        let joined = settings.server.clone().filter(|_| settings.mode == Mode::Join);
        let (base_url, token) = match &joined {
            Some(server) => (format!("http://{}", server.address), settings.token.clone()),
            None => (local_base_url(&directory), None),
        };
        let connection = Connection {
            mode: settings.mode,
            base_url,
            token,
            fallback: false,
            server: settings.server.clone(),
            when_away: WhenAway::Wait,
            decided: settings.decided,
            client_name: client_name(),
            client_id: settings.client_id.clone(),
        };
        Self { directory, settings: Mutex::new(settings), connection }
    }

    fn change(&self, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
        let mut settings = self.settings.lock().map_err(|_| "Server settings are unavailable")?;
        let mut next = settings.clone();
        change(&mut next);
        next.save(&self.directory)?;
        *settings = next;
        Ok(())
    }

    pub fn connection(&self) -> Connection {
        self.connection.clone()
    }

    pub fn client_id(&self) -> String {
        self.settings.lock().map(|settings| settings.client_id.clone()).unwrap_or_default()
    }
}

/// A request to this run's server, with this device's token.
pub fn server_request(app: &tauri::AppHandle, method: reqwest::Method, path: &str) -> Result<reqwest::blocking::RequestBuilder, String> {
    let link = app.state::<ServerLink>();
    let request = http()?.request(method, format!("{}{path}", link.connection.base_url));
    Ok(match &link.connection.token {
        Some(token) => request.bearer_auth(token),
        None => request,
    })
}

#[tauri::command]
pub fn server_connection(link: tauri::State<'_, ServerLink>) -> Connection {
    link.connection.clone()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    pub id: String,
    pub name: String,
    pub version: String,
    pub address: String,
}

/// Every IPv4 broadcast address this machine can send to. Windows sends the all-ones
/// broadcast out of a single adapter (often a virtual one), so each subnet is asked directly.
fn broadcast_targets() -> Vec<Ipv4Addr> {
    let mut targets = vec![Ipv4Addr::BROADCAST];
    for interface in if_addrs::get_if_addrs().unwrap_or_default() {
        if interface.is_loopback() {
            continue;
        }
        if let if_addrs::IfAddr::V4(address) = interface.addr {
            let broadcast = address.broadcast.unwrap_or_else(|| {
                Ipv4Addr::from(u32::from(address.ip) | !u32::from(address.netmask))
            });
            if !targets.contains(&broadcast) {
                targets.push(broadcast);
            }
        }
    }
    targets
}

fn discover(timeout: Duration) -> Result<Vec<DiscoveredServer>, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|error| format!("Could not search the network: {error}"))?;
    socket.set_broadcast(true).map_err(|error| error.to_string())?;
    for target in broadcast_targets() {
        let _ = socket.send_to(DISCOVERY_REQUEST, (target, DISCOVERY_PORT));
    }
    let deadline = Instant::now() + timeout;
    let mut found: Vec<DiscoveredServer> = Vec::new();
    let mut buffer = [0_u8; 2048];
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()) {
        socket.set_read_timeout(Some(remaining)).map_err(|error| error.to_string())?;
        let Ok((length, sender)) = socket.recv_from(&mut buffer) else { break };
        let Ok(reply) = serde_json::from_slice::<Value>(&buffer[..length]) else { continue };
        let (Some("ambra"), Some(id), Some(name), Some(port)) = (
            reply["service"].as_str(),
            reply["id"].as_str(),
            reply["name"].as_str(),
            reply["port"].as_u64().and_then(|port| u16::try_from(port).ok()),
        ) else {
            continue;
        };
        // One server answers once per subnet it's on; keep the first address that replied.
        if found.iter().any(|server| server.id == id) {
            continue;
        }
        found.push(DiscoveredServer {
            id: id.to_owned(),
            name: name.to_owned(),
            version: reply["version"].as_str().unwrap_or("").to_owned(),
            address: SocketAddr::new(sender.ip(), port).to_string(),
        });
    }
    Ok(found)
}

#[tauri::command]
pub async fn discover_servers(timeout_ms: Option<u64>) -> Result<Vec<DiscoveredServer>, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(1500).clamp(200, 10_000));
    tauri::async_runtime::spawn_blocking(move || discover(timeout))
        .await
        .map_err(|error| error.to_string())?
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStarted {
    request_id: String,
    code: String,
    address: String,
    server_name: String,
}

#[tauri::command]
pub async fn start_pairing(link: tauri::State<'_, ServerLink>, address: String) -> Result<PairingStarted, String> {
    let address = normalize_address(&address)?;
    let client_id = link.client_id();
    tauri::async_runtime::spawn_blocking(move || {
        let client = http()?;
        let info = client
            .get(format!("http://{address}/api/server/info"))
            .send()
            .map_err(|_| format!("No Ambra server answered at {address}"))
            .and_then(answer)?;
        if info["service"] != "ambra" {
            return Err(format!("{address} isn't an Ambra server"));
        }
        let started = client
            .post(format!("http://{address}/api/pair/request"))
            .json(&json!({ "clientId": client_id, "clientName": client_name() }))
            .send()
            .map_err(|error| error.to_string())
            .and_then(answer)?;
        Ok(PairingStarted {
            request_id: started["requestId"].as_str().unwrap_or_default().to_owned(),
            code: started["code"].as_str().unwrap_or_default().to_owned(),
            server_name: info["name"].as_str().unwrap_or("the server").to_owned(),
            address,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `pending`, `denied`, `expired`, or `approved` — in which case this app is now joined to
/// the server, effective once it restarts.
#[tauri::command]
pub async fn poll_pairing(link: tauri::State<'_, ServerLink>, address: String, request_id: String) -> Result<String, String> {
    let address = normalize_address(&address)?;
    let url = format!("http://{address}/api/pair/request/{}", urlencoding_path(&request_id));
    let reply = tauri::async_runtime::spawn_blocking(move || http()?.get(url).send().map_err(|error| error.to_string()).and_then(answer))
        .await
        .map_err(|error| error.to_string())??;
    let status = reply["status"].as_str().unwrap_or("expired").to_owned();
    if status == "approved" {
        let token = reply["token"].as_str().ok_or("The server approved but sent no token")?.to_owned();
        let server = JoinedServer {
            id: reply["server"]["id"].as_str().unwrap_or_default().to_owned(),
            name: reply["server"]["name"].as_str().unwrap_or("Ambra server").to_owned(),
            address,
        };
        link.change(|settings| {
            settings.mode = Mode::Join;
            settings.decided = true;
            settings.server = Some(server);
            settings.token = Some(token);
        })?;
    }
    Ok(status)
}

fn urlencoding_path(value: &str) -> String {
    value.chars().filter(char::is_ascii_alphanumeric).collect()
}

/// Back to connecting to a separately started local server, once the app restarts.
#[tauri::command]
pub fn leave_server(link: tauri::State<'_, ServerLink>) -> Result<(), String> {
    link.change(|settings| {
        settings.mode = Mode::Host;
        settings.decided = true;
        settings.server = None;
        settings.token = None;
    })
}

/// The first-run offer to join a server on the network was answered or dismissed.
#[tauri::command]
pub fn set_server_link_decided(link: tauri::State<'_, ServerLink>) -> Result<(), String> {
    link.change(|settings| settings.decided = true)
}

/// Removes this machine's own copy of the library, playlists and settings, so a joined app
/// starts from the server's. Device settings (outputs and DSP) and local music stay.
#[tauri::command]
pub async fn clear_local_state(app: tauri::AppHandle) -> Result<(), String> {
    let data = crate::persistent_data_directory(&app)?;
    let cache = app.path().app_cache_dir().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        for path in [data.join("desktop-state"), data.join("desktop-state.json")] {
            let removed = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
            if let Err(error) = removed
                && error.kind() != std::io::ErrorKind::NotFound
            {
                return Err(format!("Could not clear {}: {error}", path.display()));
            }
        }
        for name in ["streaming-library.json", "service-playlists.json"] {
            let _ = std::fs::remove_file(cache.join(name));
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

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
        settings.server = Some(JoinedServer { id: "core".into(), name: "Music server".into(), address: "127.0.0.1:9".into() });
        settings.token = Some("paired-token".into());
        settings.save(&directory).unwrap();
        let connection = ServerLink::start(directory.clone()).connection();
        assert_eq!(connection.base_url, "http://127.0.0.1:9");
        assert_eq!(connection.token.as_deref(), Some("paired-token"));
        assert!(!connection.fallback);
        assert_eq!(connection.when_away, WhenAway::Wait);
        std::fs::remove_file(directory.join(FILE_NAME)).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
