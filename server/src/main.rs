#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod access;
mod api;
mod artwork_cache;
mod artwork_quality;
mod http_client;
mod media_cache;
mod models;
mod providers;
mod storage;
mod write_behind;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    storage::migrate_legacy();
    api::serve().await
}
