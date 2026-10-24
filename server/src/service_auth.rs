//! Explicit sign-out survives restarts, including installations with environment tokens.
use std::io;

static CREDENTIAL_IO: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A background refresh cannot recreate a credential file after disconnect deleted it.
pub fn credentials_guard() -> std::sync::MutexGuard<'static, ()> {
    CREDENTIAL_IO.lock().unwrap_or_else(|error| error.into_inner())
}

pub fn disconnected(provider: &str) -> bool {
    matches!(provider, "tidal" | "qobuz" | "spotify")
        && crate::storage::config_path(&format!("{provider}-disconnected")).is_file()
}

pub fn set_disconnected(provider: &str, disconnected: bool) -> io::Result<()> {
    assert!(matches!(provider, "tidal" | "qobuz" | "spotify"));
    let path = crate::storage::config_path(&format!("{provider}-disconnected"));
    if disconnected { std::fs::write(path, b"signed out") } else { remove(path) }
}

pub fn remove(path: impl AsRef<std::path::Path>) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}
