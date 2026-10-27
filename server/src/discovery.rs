//! Server configuration controls the shared native LAN discovery responder.
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use crate::network::{SharedNetwork, server_info};
pub async fn run(network: SharedNetwork, cancel: CancellationToken) {
    let diagnostics = network.clone();
    let advertisement = Arc::new(move || {
        if !network.config.read().ok()?.discovery { return None; }
        let info = server_info(&network);
        Some(ambra_net::lan::Advertisement { service: "ambra".into(), id: info.id, name: info.name, version: info.version.into(), port: info.port, public_key: Some(info.public_key), secure_port: info.secure_port })
    });
    if let Err(error) = ambra_net::lan::serve_discovery(advertisement, cancel).await { *diagnostics.discovery_error.write().unwrap_or_else(|p| p.into_inner()) = Some(error.to_string()); eprintln!("LAN discovery stopped: {error}"); }
}
