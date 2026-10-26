//! Explicitly starts an independent background server, without an app or terminal lifetime.
use std::{fs::{File, OpenOptions}, net::SocketAddr, process::{Command, Stdio}, time::Duration};
use serde_json::json;

static SHUTDOWN: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub fn stop() { SHUTDOWN.notify_one(); }
pub async fn stopped() { SHUTDOWN.notified().await; }

pub fn lock() -> Result<File, std::io::Error> {
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true)
        .open(crate::storage::data_path("server.lock"))?;
    file.try_lock().map_err(|error| std::io::Error::other(format!("An Ambra server is already running for this library: {error}")))?;
    Ok(file)
}

pub fn record(address: SocketAddr) -> Result<(), String> {
    crate::server_config::write_private(&crate::storage::data_path("server-runtime.json"),
        &serde_json::to_vec(&json!({ "pid": std::process::id(), "address": address.to_string() })).map_err(|e| e.to_string())?)
}

fn configured_address() -> SocketAddr {
    std::env::var("AMBRA_SERVER_ADDRESS").ok()
        .and_then(|address| crate::server_config::parse_bind(&address).ok())
        .or_else(|| crate::server_config::ServerConfig::load_existing().map(|config| config.address()))
        .unwrap_or_else(|| crate::server_config::DEFAULT_BIND.parse().expect("valid default bind"))
}

pub fn local_address() -> SocketAddr {
    let recorded = std::fs::read(crate::storage::data_path("server-runtime.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value["address"].as_str()?.parse::<SocketAddr>().ok());
    let configured = std::env::var("AMBRA_SERVER_ADDRESS").ok()
        .and_then(|address| crate::server_config::parse_bind(&address).ok())
        .or_else(|| recorded)
        .unwrap_or_else(configured_address);
    SocketAddr::from(([127, 0, 0, 1], configured.port()))
}

pub async fn start(bind: Option<String>) -> Result<String, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_millis(500)).build().map_err(|e| e.to_string())?;
    let current = local_address();
    if is_running(&client, current).await { return Ok(format!("Ambra server is already running at http://{current}.")); }
    let address = bind.as_deref().map(crate::server_config::parse_bind).transpose()?
        .unwrap_or_else(configured_address);
    let local = SocketAddr::from(([127, 0, 0, 1], address.port()));
    let log_path = crate::storage::data_path("server.log");
    let log = OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| e.to_string())?;
    // Run a copy so app updates and CLI reinstalls can replace their executable while the
    // server keeps running (Windows locks executables that are in use). The copy always has
    // the same path, so the firewall's permission for it carries over to every build; it is
    // free to replace here, since no server is running.
    let source = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = crate::storage::data_path("server-bin");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let executable = directory.join(format!("ambra-server{}", std::env::consts::EXE_SUFFIX));
    if !same_build(&source, &executable) { std::fs::copy(&source, &executable).map_err(|e| e.to_string())?; }
    // Versioned copies from before, each of which the firewall had to be asked about.
    if let Ok(entries) = std::fs::read_dir(&directory) {
        for entry in entries.flatten().filter(|entry| entry.path().is_dir()) { let _ = std::fs::remove_dir_all(entry.path()); }
    }
    let mut command = Command::new(executable);
    command.args(["serve", "--tray"]);
    if let Some(bind) = bind { command.args(["--bind", &bind]); }
    command.stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log);
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000 | 0x0000_0200); // no console; independent process group
    }
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        unsafe { command.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }); }
    }
    let mut child = command.spawn().map_err(|e| format!("Could not start the server: {e}"))?;
    for _ in 0..60 {
        if is_running(&client, local).await {
            return Ok(format!("Ambra server is running in the background at http://{local}.\nYou can close this terminal. Use the tray menu or `ambra-server stop` to stop it."));
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("The server exited ({status}); see {}", log_path.display()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("The server has not answered yet; see {}", log_path.display()))
}

/// Whether `copy` is already `source`: the same size, and not older.
fn same_build(source: &std::path::Path, copy: &std::path::Path) -> bool {
    let (Ok(source), Ok(copy)) = (source.metadata(), copy.metadata()) else { return false };
    source.len() == copy.len() && matches!((source.modified(), copy.modified()), (Ok(built), Ok(copied)) if copied >= built)
}

async fn is_running(client: &reqwest::Client, address: SocketAddr) -> bool {
    match client.get(format!("http://{address}/api/server/info")).send().await {
        Ok(response) => response.json::<serde_json::Value>().await.ok().is_some_and(|value| value["service"] == "ambra"),
        Err(_) => false,
    }
}
