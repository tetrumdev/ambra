#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod access;
mod api;
mod artwork_cache;
mod artwork_quality;
mod http_client;
mod lyrics;
mod media_cache;
mod models;
mod playlists;
mod providers;
mod storage;
mod user_state;
mod write_behind;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    exit_with_parent();
    storage::migrate_legacy();
    api::serve().await
}

/// When the desktop app launches the server it keeps our stdin open. The OS
/// closes it if the app exits or crashes, so the server never outlives it and
/// keeps the port.
fn exit_with_parent() {
    if std::env::var_os("AMBRA_EXIT_WITH_PARENT").is_none() {
        return;
    }
    std::thread::spawn(|| {
        let mut buffer = [0_u8; 64];
        let mut stdin = std::io::stdin();
        while let Ok(read) = std::io::Read::read(&mut stdin, &mut buffer) {
            if read == 0 {
                break;
            }
        }
        std::process::exit(0);
    });
}
