//! `ambra-server <command>`: runs the server, or manages the one running on this machine.
//!
//! Commands that change a running server go through its local-only API, so pairing state
//! and settings never disagree with what the server holds in memory. With no server
//! running, settings are edited in its settings file directly.

use std::time::Duration;

use serde_json::{Value, json};

use crate::server_config::{ServerConfig, parse_bind, validate_name};

const HELP: &str = "\
Ambra server

USAGE:
    ambra-server start [--bind <address>]      Start the background server and tray icon
    ambra-server stop                          Stop the local background server
    ambra-server serve [--bind <address>]      Run in this terminal (Ctrl+C to stop)
    ambra-server status                        Is it running, and where
    ambra-server config show                   Current settings
    ambra-server config set bind <address>     Where to listen: lan, local, an IP, or IP:port
    ambra-server config set name <name>        The name clients see
    ambra-server config set discovery on|off   Whether clients on the network can find it
    ambra-server network status|diagnose         Native listeners and sanitized network diagnostics
    ambra-server network identity                Public cryptographic server identity
    ambra-server network endpoint <IP:port>       Public hint for the next QR/pwnat attempt
    ambra-server network p2p on|off               Enable or disable remote direct networking
    ambra-server pair qr                          Public QR pairing link (requires running server)
    ambra-server pair list                     Devices waiting to pair, and paired devices
    ambra-server pair approve <code>           Let the device showing <code> use the server
    ambra-server pair deny <code>              Refuse a device's request
    ambra-server pair revoke <device>          Unpair a device, by name or ID
    ambra-server login spotify                 Sign in with librespot, optionally pair Soloist
    ambra-server spotify status                Sanitized playback backend status
    ambra-server spotify backend librespot|soloist
    ambra-server spotify soloist pair|reset|check|sign-out
    ambra-server spotify soloist key           Enter a personal API key without echo
    ambra-server spotify soloist install <absolute-path>
    ambra-server help                          This message

The server shares itself with the local network by default (`config set bind lan`).
Use `config set bind local` to keep it to this machine. Changing where it listens takes
effect when the server restarts; other settings apply at once.";

pub enum Command {
    Start { bind: Option<String> },
    Serve { bind: Option<String>, tray: bool },
    Run(Vec<String>),
}

pub fn parse(arguments: Vec<String>) -> Result<Command, String> {
    match arguments.first().map(String::as_str) {
        None => Ok(Command::Run(vec!["help".into()])),
        Some("start" | "serve" | "--bind") => {
            let rest = if arguments[0] == "--bind" { &arguments[..] } else { &arguments[1..] };
            let tray = arguments[0] == "serve" && rest.first().is_some_and(|arg| arg == "--tray");
            let rest = if tray { &rest[1..] } else { rest };
            let bind = match rest {
                [] => None,
                [flag, address] if flag == "--bind" => {
                    parse_bind(address)?;
                    Some(address.clone())
                }
                _ => return Err("Usage: ambra-server start [--bind <address>]".into()),
            };
            if arguments[0] == "start" { Ok(Command::Start { bind }) } else { Ok(Command::Serve { bind, tray }) }
        }
        Some(_) => Ok(Command::Run(arguments)),
    }
}

/// Runs a management command, returning what to print.
pub async fn run(arguments: Vec<String>) -> Result<String, String> {
    let words = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    match words.as_slice() {
        ["help" | "--help" | "-h"] => Ok(HELP.into()),
        ["status"] => status().await,
        ["network", "status" | "diagnose"] => match local("GET", "/api/local/network", None).await {
            Ok(status) => pretty(status),
            Err(error) if not_running(&error) => Ok(error),
            Err(error) => Err(error),
        },
        ["network", "identity"] => {
            let identity = ambra_net::Identity::load_or_create(&crate::storage::config_path("network-identity.key")).map_err(|e| e.to_string())?;
            Ok(identity.public_key().to_string())
        },
        ["network", "p2p", enabled @ ("on" | "off")] => config_set(json!({ "p2p": *enabled == "on" })).await,
        ["network", "endpoint", endpoint] => {
            let endpoint = endpoint.parse::<std::net::SocketAddr>().map_err(|_| "Use a public IP:port")?;
            if ambra_net::lan::is_local(endpoint.ip()) || endpoint.port() == 0 { return Err("Use a public IP:port".into()); }
            config_set(json!({ "publicEndpoint": endpoint })).await
        },
        ["pair", "qr"] => {
            let response = local("GET", "/api/local/pairing/qr", None).await?;
            let payload = response["payload"].as_str().ok_or("No pairing payload")?;
            let code = qrcode::QrCode::new(payload.as_bytes()).map_err(|e| e.to_string())?;
            Ok(format!("{}\n{}\nApprove the six-digit code after the device connects.", code.render::<char>().quiet_zone(true).module_dimensions(2, 1).build(), payload))
        },
        ["login", "spotify"] => login_spotify().await,
        ["spotify", "status"] => pretty(local("GET", "/api/spotify/playback/status", None).await?),
        ["spotify", "backend", backend @ ("librespot" | "soloist")] => pretty(local("POST", "/api/local/spotify/playback", Some(json!({ "backend": backend }))).await?),
        ["spotify", "soloist", action @ ("pair" | "reset" | "check" | "sign-out")] => pretty(local("POST", &format!("/api/local/spotify/soloist/{action}"), None).await?),
        ["spotify", "soloist", "key"] => {
            let key = rpassword::prompt_password("Personal Soloist API key (hidden): ").map_err(|_| "Could not read the key securely from the terminal")?;
            local("POST", "/api/local/spotify/playback", Some(json!({ "apiKey": key }))).await?;
            Ok("Soloist API key saved on the server.".into())
        }
        ["spotify", "soloist", "install", path] => pretty(local("POST", "/api/local/spotify/soloist/install", Some(json!({ "executable": path }))).await?),
        ["stop"] => { local("POST", "/api/local/stop", None).await?; Ok("Ambra server is stopping.".into()) }
        ["config"] | ["config", "show"] => config_show().await,
        ["config", "set", "bind", address] => config_set(json!({ "bind": address })).await,
        ["config", "set", "name", name @ ..] if !name.is_empty() => {
            config_set(json!({ "name": name.join(" ") })).await
        }
        ["config", "set", "discovery", value] => {
            let on = match *value {
                "on" | "true" | "yes" => true,
                "off" | "false" | "no" => false,
                _ => return Err("Use `on` or `off`".into()),
            };
            config_set(json!({ "discovery": on })).await
        }
        ["pair"] | ["pair", "list"] => pair_list().await,
        ["pair", "approve", code] => {
            let reply = local("POST", "/api/local/pairing/approve", Some(json!({ "code": code }))).await?;
            Ok(format!("Paired {}.", reply["paired"].as_str().unwrap_or("the device")))
        }
        ["pair", "deny", code] => {
            let reply = local("POST", "/api/local/pairing/deny", Some(json!({ "code": code }))).await?;
            Ok(format!("Refused {}.", reply["denied"].as_str().unwrap_or("the device")))
        }
        ["pair", "revoke", device @ ..] if !device.is_empty() => {
            let reply = local("POST", "/api/local/pairing/revoke", Some(json!({ "client": device.join(" ") }))).await?;
            Ok(format!("Unpaired {}.", reply["revoked"].as_str().unwrap_or("the device")))
        }
        _ => Err(format!("Unknown command `{}`.\n\n{HELP}", arguments.join(" "))),
    }
}

fn pretty(value: Value) -> Result<String, String> { serde_json::to_string_pretty(&value).map_err(|e| e.to_string()) }

async fn login_spotify() -> Result<String, String> {
    use std::io::{IsTerminal, Write};
    println!("Signing in to Spotify through librespot. Complete the browser login on the server machine.");
    local("POST", "/api/auth/spotify/start", None).await?;
    if !std::io::stdin().is_terminal() { return Ok("Spotify connected with librespot. Use `ambra-server spotify backend soloist` to opt into optional Soloist setup.".into()); }
    print!("Also configure Soloist for experimental lossless playback? [y/N] ");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    let mut answer = String::new(); std::io::stdin().read_line(&mut answer).map_err(|e| e.to_string())?;
    if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") { return Ok("Spotify connected with librespot.".into()); }
    local("POST", "/api/local/spotify/playback", Some(json!({ "backend": "soloist" }))).await?;
    println!("Install your own Soloist executable: https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates");
    println!("Generate a personal key: https://developer.spotify.com/dashboard/soloist");
    println!("Audio capture currently requires Linux. Release builds do not forward Spotify audio.");
    let key = rpassword::prompt_password("Personal Soloist API key (hidden; leave empty to finish later): ").map_err(|_| "Could not read the key securely from the terminal")?;
    if key.trim().is_empty() { return Ok("Soloist selected. Finish setup in Services on the server machine, or run `ambra-server spotify soloist key`.".into()); }
    local("POST", "/api/local/spotify/playback", Some(json!({ "apiKey": key }))).await?;
    let status = local("GET", "/api/spotify/playback/status", None).await?;
    if status["state"] == "not_installed" { return Ok("Key saved. Install Soloist, then run `ambra-server spotify soloist install /absolute/path/to/soloist` and `ambra-server spotify soloist pair`.".into()); }
    local("POST", "/api/local/spotify/soloist/pair", None).await?;
    Ok("Open the official Spotify app on the same network. Select Ambra Soloist Pairing with the same account. Check `ambra-server spotify status`.".into())
}

fn local_url(path: &str) -> String {
    let port = crate::server_process::local_address().port();
    format!("http://127.0.0.1:{port}{path}")
}

/// A local-only API call; `Err` says whether the server is running at all.
async fn local(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(if path == "/api/auth/spotify/start" { 180 } else { 45 }))
        .build()
        .map_err(|error| error.to_string())?;
    let request = match method {
        "POST" => client.post(local_url(path)).json(&body.unwrap_or(Value::Null)),
        _ => client.get(local_url(path)),
    };
    let response = request.send().await.map_err(|error| {
        if error.is_connect() || error.is_timeout() {
            "The Ambra server isn't running on this machine.".to_owned()
        } else {
            error.to_string()
        }
    })?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(OLDER_SERVER.into());
    }
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(value)
    } else {
        Err(value["error"].as_str().map_or_else(|| format!("The server answered {status}"), str::to_owned))
    }
}

const OLDER_SERVER: &str = "The Ambra server running on this machine is an older version; restart it to use this command.";

/// No server here holds the settings in memory, so the file can be edited directly.
fn not_running(error: &str) -> bool {
    error.starts_with("The Ambra server isn't running") || error == OLDER_SERVER
}

async fn status() -> Result<String, String> {
    match local("GET", "/api/local/config", None).await {
        Ok(config) => {
            let listening = config["listening"].as_str().unwrap_or("?");
            let shared = parse_bind(listening).is_ok_and(|address| !address.ip().is_loopback());
            let mut lines = vec![
                format!("Running as \"{}\" on {listening}.", config["name"].as_str().unwrap_or("?")),
                if shared {
                    format!("Shared with the local network{}.", if config["discovery"] == true { "; clients can find it" } else { ", but hidden from discovery" })
                } else {
                    "Only this machine can use it.".into()
                },
                format!("{} paired device(s).", config["pairedClients"]),
            ];
            if let Ok(pairing) = local("GET", "/api/local/pairing", None).await {
                let waiting = pairing["pending"].as_array().map_or(0, Vec::len);
                if waiting > 0 {
                    lines.push(format!("{waiting} device(s) waiting to pair; see `ambra-server pair list`."));
                }
            }
            if config["bind"] != config["listening"] {
                lines.push(format!("Will listen on {} after a restart.", config["bind"].as_str().unwrap_or("?")));
            }
            Ok(lines.join("\n"))
        }
        Err(error) if not_running(&error) => Ok(error),
        Err(error) => Err(error),
    }
}

async fn config_show() -> Result<String, String> {
    let config = match local("GET", "/api/local/config", None).await {
        Ok(config) => config,
        Err(error) if not_running(&error) => {
            let config = ServerConfig::load();
            json!({
                "name": config.name, "bind": config.bind, "listening": null, "discovery": config.discovery, "p2p": config.p2p,
                "pairedClients": config.paired_clients.len(), "path": ServerConfig::path().display().to_string(),
            })
        }
        Err(error) => return Err(error),
    };
    Ok(format!(
        "name:       {}\nbind:       {}{}\ndiscovery:  {}\np2p:        {}\npaired:     {} device(s)\nfile:       {}",
        config["name"].as_str().unwrap_or("?"),
        config["bind"].as_str().unwrap_or("?"),
        match config["listening"].as_str() {
            Some(listening) if Some(listening) != config["bind"].as_str() => format!(" (listening on {listening} until restarted)"),
            Some(_) => String::new(),
            None => " (not running)".into(),
        },
        if config["discovery"] == true { "on" } else { "off" },
        if config["p2p"] == true { "on" } else { "off" },
        config["pairedClients"],
        config["path"].as_str().unwrap_or("?"),
    ))
}

async fn config_set(change: Value) -> Result<String, String> {
    let restart = change.get("bind").is_some();
    match local("POST", "/api/local/config", Some(change.clone())).await {
        Ok(_) => {}
        Err(error) if not_running(&error) => {
            let mut config = ServerConfig::load();
            if let Some(bind) = change["bind"].as_str() {
                config.bind = parse_bind(bind)?.to_string();
            }
            if let Some(name) = change["name"].as_str() {
                validate_name(name)?;
                config.name = name.trim().to_owned();
            }
            if let Some(p2p) = change["p2p"].as_bool() { config.p2p = p2p; }
            if let Some(endpoint) = change["publicEndpoint"].as_str() { config.public_endpoint = Some(endpoint.parse().map_err(|_| "Invalid public endpoint")?); }
            if let Some(discovery) = change["discovery"].as_bool() {
                config.discovery = discovery;
            }
            config.save()?;
            return Ok(format!("Saved.\n\n{}", config_show().await?));
        }
        Err(error) => return Err(error),
    }
    let shown = config_show().await?;
    Ok(if restart { format!("Saved; restart the server to listen there.\n\n{shown}") } else { format!("Saved.\n\n{shown}") })
}

async fn pair_list() -> Result<String, String> {
    let pairing = local("GET", "/api/local/pairing", None).await?;
    let mut lines = Vec::new();
    match pairing["pending"].as_array() {
        Some(pending) if !pending.is_empty() => {
            lines.push("Waiting to pair:".to_owned());
            for device in pending {
                lines.push(format!(
                    "  {}  {} ({})  — `ambra-server pair approve {}`",
                    device["code"].as_str().unwrap_or("?"),
                    device["clientName"].as_str().unwrap_or("?"),
                    device["address"].as_str().unwrap_or("?"),
                    device["code"].as_str().unwrap_or("?"),
                ));
            }
        }
        _ => lines.push("No devices are waiting to pair.".into()),
    }
    match pairing["paired"].as_array() {
        Some(paired) if !paired.is_empty() => {
            lines.push(String::new());
            lines.push("Paired:".into());
            for device in paired {
                lines.push(format!("  {}  (ID {})", device["name"].as_str().unwrap_or("?"), device["id"].as_str().unwrap_or("?")));
            }
        }
        _ => {}
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starting_is_explicit_and_serve_is_foreground() {
        assert!(matches!(parse(vec![]).unwrap(), Command::Run(words) if words == ["help"]));
        for name in ["start", "serve"] {
            let parsed = parse(vec![name.into()]).unwrap();
            assert!(matches!(parsed, Command::Start { bind: None } | Command::Serve { bind: None, tray: false }));
            let parsed = parse(vec![name.into(), "--bind".into(), "127.0.0.1:39147".into()]).unwrap();
            assert!(matches!(parsed, Command::Start { bind: Some(address) } | Command::Serve { bind: Some(address), tray: false } if address == "127.0.0.1:39147"));
            assert!(parse(vec![name.into(), "--bind".into()]).is_err());
            assert!(parse(vec![name.into(), "--bind".into(), "invalid".into()]).is_err());
        }
        assert!(matches!(parse(vec!["serve".into(), "--tray".into()]).unwrap(), Command::Serve { tray: true, .. }));
    }
}
