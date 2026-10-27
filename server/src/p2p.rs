//! Owns the shared native networking lifecycle; music and authorization remain in Axum.
use std::{net::SocketAddr, time::Duration};
use tokio_util::sync::CancellationToken;
use crate::network::SharedNetwork;

pub async fn run(network: SharedNetwork, app: axum::Router, address: SocketAddr, cancel: CancellationToken) {
    let port = network.config.read().unwrap_or_else(|p| p.into_inner()).secure_port;
    let secure = SocketAddr::new(address.ip(), port);
    let mut tasks = tokio::task::JoinSet::new();
    if !address.ip().is_loopback() { tasks.spawn(crate::discovery::run(network.clone(), cancel.clone())); }
    match ambra_net::lan::bind(secure).await {
        Ok(listener) => {
            if let Ok(mut listening) = network.secure_listening.write() { *listening = listener.local_addr().ok(); }
            let identity = network.identity.clone(); let app = app.clone(); let cancel = cancel.clone();
            let diagnostics = network.clone();
            tasks.spawn(async move {
                if let Err(error) = ambra_net::lan::serve(listener, identity, app, cancel).await {
                    *diagnostics.lan_error.write().unwrap_or_else(|p| p.into_inner()) = Some(error.to_string());
                    eprintln!("Secure LAN listener stopped: {error}");
                }
                *diagnostics.secure_listening.write().unwrap_or_else(|p| p.into_inner()) = None;
            });
        }
        Err(error) => { *network.lan_error.write().unwrap_or_else(|p| p.into_inner()) = Some(error.to_string()); eprintln!("Secure LAN unavailable on {secure}: {error}"); },
    }
    let mut remote_cancel: Option<CancellationToken> = None;
    let mut remote_tasks = tokio::task::JoinSet::new();
    loop {
        let enabled = network.config.read().map(|c| c.p2p).unwrap_or(false) && !address.ip().is_loopback();
        if enabled && remote_cancel.is_none() {
            let stop = cancel.child_token(); remote_cancel = Some(stop.clone());
            let status = network.dht_status.clone(); let identity = network.identity.clone(); let dht_app = app.clone(); let stop_dht = stop.clone();
            remote_tasks.spawn(async move {
                if let Err(error) = ambra_net::hyperdht::serve(identity, dht_app, status.clone(), stop_dht).await {
                    if let Ok(mut status) = status.write() { status.running = false; status.error = Some(error.to_string()); }
                }
            });
            let identity = network.identity.clone(); let app = app.clone(); let network = network.clone();
            remote_tasks.spawn(async move {
                if let Err(error) = ambra_net::pwnat::serve(secure, identity, app, stop).await {
                    if let Ok(mut status) = network.pwnat_status.write() { *status = Some(error.to_string()); }
                }
            });
        } else if !enabled && remote_cancel.is_some() {
            if let Some(stop) = remote_cancel.take() { stop.cancel(); }
            let _ = tokio::time::timeout(Duration::from_secs(3), async { while remote_tasks.join_next().await.is_some() {} }).await;
            remote_tasks.shutdown().await;
        }
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = network.changed.notified() => {},
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            Some(_) = remote_tasks.join_next(), if !remote_tasks.is_empty() => {},
        }
    }
    if let Some(stop) = remote_cancel { stop.cancel(); }
    let _ = tokio::time::timeout(Duration::from_secs(3), async { while remote_tasks.join_next().await.is_some() {} }).await;
    remote_tasks.shutdown().await; tasks.shutdown().await;
}
