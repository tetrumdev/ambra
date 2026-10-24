//! The server's own settings: where it listens, what it calls itself on the network, and
//! which clients have been paired. Only a hash of each client's token is kept.

use std::{fs, io::Write, net::SocketAddr, path::PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Every interface, so other devices on the network can reach the server (as Roon's core does).
pub const DEFAULT_BIND: &str = "0.0.0.0:38147";
pub const LOCAL_BIND: &str = "127.0.0.1:38147";
const FILE_NAME: &str = "server.json";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairedClient {
    pub id: String,
    pub name: String,
    pub token_sha256: String,
    pub paired_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    /// Stable across restarts, so clients recognise the same server under a new address.
    pub id: String,
    pub name: String,
    pub bind: String,
    #[serde(default = "enabled")]
    pub discovery: bool,
    #[serde(default)]
    pub paired_clients: Vec<PairedClient>,
}

fn enabled() -> bool {
    true
}

impl ServerConfig {
    fn new() -> Self {
        Self {
            id: random_hex(16),
            name: machine_name(),
            bind: DEFAULT_BIND.into(),
            discovery: true,
            paired_clients: Vec::new(),
        }
    }

    #[cfg(test)]
    pub fn load_default_for_tests() -> Self {
        Self::new()
    }

    pub fn path() -> PathBuf {
        crate::storage::config_path(FILE_NAME)
    }

    /// The saved settings, if there are any valid ones.
    pub fn load_existing() -> Option<Self> {
        let bytes = fs::read(Self::path()).ok()?;
        serde_json::from_slice::<Self>(&bytes).ok().filter(|config| config.validate().is_ok())
    }

    /// The saved settings, or new ones (saved straight away so the ID stays put).
    pub fn load() -> Self {
        let path = Self::path();
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Self>(&bytes) {
                Ok(config) if config.validate().is_ok() => return config,
                Ok(_) | Err(_) => eprintln!(
                    "Ignoring invalid server settings in {}; starting from defaults",
                    path.display()
                ),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!("Could not read server settings: {error}"),
        }
        let config = Self::new();
        if let Err(error) = config.save() {
            eprintln!("Could not save server settings: {error}");
        }
        config
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() || self.id.len() > 64 {
            return Err("The server ID is invalid".into());
        }
        validate_name(&self.name)?;
        parse_bind(&self.bind).map(|_| ())
    }

    pub fn save(&self) -> Result<(), String> {
        self.validate()?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        write_private(&Self::path(), &bytes)
    }

    pub fn address(&self) -> SocketAddr {
        parse_bind(&self.bind).unwrap_or_else(|_| DEFAULT_BIND.parse().expect("valid default"))
    }

    pub fn client_for_token(&self, token: &str) -> Option<&PairedClient> {
        let hash = token_hash(token);
        self.paired_clients
            .iter()
            .find(|client| constant_time_eq(client.token_sha256.as_bytes(), hash.as_bytes()))
    }
}

pub fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err("A server name needs 1–64 printable characters".into());
    }
    Ok(())
}

/// `lan` and `local` are shorthands; a bare IP keeps the default port.
pub fn parse_bind(value: &str) -> Result<SocketAddr, String> {
    let value = value.trim();
    let expanded = match value.to_ascii_lowercase().as_str() {
        "lan" | "network" | "all" => DEFAULT_BIND.to_owned(),
        "local" | "localhost" => LOCAL_BIND.to_owned(),
        _ => value.to_owned(),
    };
    expanded
        .parse::<SocketAddr>()
        .or_else(|_| {
            expanded
                .parse::<std::net::IpAddr>()
                .map(|ip| SocketAddr::new(ip, 38147))
        })
        .map_err(|_| format!("\"{value}\" is not an address; use an IP such as 192.168.1.20, an IP and port, `lan` or `local`"))
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).expect("the operating system's random source is available");
    bytes
}

pub fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer).expect("the operating system's random source is available");
    hex(&buffer)
}

pub fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0_u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn machine_name() -> String {
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|output| String::from_utf8(output.stdout).ok())
        })
        .map(|name| name.trim().trim_end_matches(".local").to_owned())
        .filter(|name| validate_name(name).is_ok());
    name.unwrap_or_else(|| "Ambra Server".into())
}

/// Replaces the file atomically; on Unix only the owner may read it, as it lists paired clients.
pub fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("The settings file has no directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Could not save {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_shorthands_and_bare_ips() {
        assert_eq!(parse_bind("lan").unwrap().to_string(), "0.0.0.0:38147");
        assert_eq!(parse_bind("local").unwrap().to_string(), "127.0.0.1:38147");
        assert_eq!(parse_bind("192.168.1.20").unwrap().to_string(), "192.168.1.20:38147");
        assert_eq!(parse_bind("10.0.0.2:9000").unwrap().to_string(), "10.0.0.2:9000");
        assert!(parse_bind("not an address").is_err());
    }

    #[test]
    fn tokens_are_found_by_hash_only() {
        let mut config = ServerConfig::new();
        config.paired_clients.push(PairedClient {
            id: "c1".into(),
            name: "Laptop".into(),
            token_sha256: token_hash("secret"),
            paired_at_ms: 0,
        });
        assert_eq!(config.client_for_token("secret").unwrap().name, "Laptop");
        assert!(config.client_for_token("Secret").is_none());
        assert!(!serde_json::to_string(&config).unwrap().contains("\"secret\""));
    }
}
