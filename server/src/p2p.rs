//! Owns the shared native networking lifecycle; music and authorization remain in Axum.
use std::{net::SocketAddr, time::Duration};
use tokio_util::sync::CancellationToken;
use crate::network::SharedNetwork;

// A listener can exit after a runtime/socket failure while configuration stays
// enabled. Its owner must restart it; a completed JoinSet entry alone cannot
// reset the configuration edge that originally started the listener.
async fn supervise_listener<F, Fut>(cancel: CancellationToken, mut listen: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let mut delay = Duration::from_secs(1);
    loop {
        if cancel.is_cancelled() { break; }
        let started = tokio::time::Instant::now();
        let operation = listen();
        tokio::pin!(operation);
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // Let the listener unannounce and close its owned sockets.
                let _ = tokio::time::timeout(Duration::from_secs(3),&mut operation).await;
                break;
            },
            _ = &mut operation => {},
        }
        if started.elapsed() >= Duration::from_secs(30) { delay = Duration::from_secs(1); }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep(delay) => {},
        }
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}

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
    let mut pwnat_cancel: Option<CancellationToken> = None;
    let mut pwnat_tasks = tokio::task::JoinSet::new();
    let mut pwnat_config = None;
    loop {
        let (enabled, pwnat_enabled, public_endpoint) = network.config.read()
            .map(|c| (c.p2p && !address.ip().is_loopback(), c.pwnat, c.public_endpoint)).unwrap_or_default();
        let desired = (enabled && pwnat_enabled, public_endpoint);
        if pwnat_config != Some(desired) {
            if let Some(stop) = pwnat_cancel.take() { stop.cancel(); }
            let _ = tokio::time::timeout(Duration::from_secs(3), async { while pwnat_tasks.join_next().await.is_some() {} }).await;
            pwnat_tasks.shutdown().await;
            *network.pwnat_status.write().unwrap_or_else(|p| p.into_inner()) = ambra_net::pwnat::Status {
                configured_endpoint: public_endpoint, ..Default::default()
            };
            pwnat_config = Some(desired);
            if desired.0 {
                let stop = cancel.child_token(); pwnat_cancel = Some(stop.clone());
                let identity = network.identity.clone(); let app = app.clone(); let status = network.pwnat_status.clone();
                pwnat_tasks.spawn(async move {
                    supervise_listener(stop.clone(), || async {
                        let result = ambra_net::pwnat::serve(secure, identity.clone(), app.clone(), stop.clone(), status.clone()).await;
                        if !stop.is_cancelled() {
                            let message = result.err().map_or_else(|| "pwnat listener stopped unexpectedly".to_owned(), |e|e.to_string());
                            eprintln!("Optional pwnat unavailable; retrying: {message}");
                            let mut status = status.write().unwrap_or_else(|p|p.into_inner());
                            status.running = false; status.error = Some(message);
                        }
                    }).await;
                });
            }
        }
        if enabled && remote_cancel.is_none() {
            let stop = cancel.child_token(); remote_cancel = Some(stop.clone());
            let status = network.dht_status.clone(); let identity = network.identity.clone(); let dht_app = app.clone(); let stop_dht = stop.clone();
            let pwnat_status = network.pwnat_status.clone();
            remote_tasks.spawn(async move {
                supervise_listener(stop_dht.clone(), || async {
                    let result = ambra_net::hyperdht::serve(identity.clone(), dht_app.clone(), status.clone(), stop_dht.clone(), Some(pwnat_status.clone())).await;
                    if !stop_dht.is_cancelled() {
                        let message = result.err().map_or_else(|| "HyperDHT listener stopped unexpectedly".to_owned(), |e|e.to_string());
                        if let Ok(mut status) = status.write() { status.running = false; status.announced = false; status.error = Some(message); }
                    }
                }).await;
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
            Some(_) = pwnat_tasks.join_next(), if !pwnat_tasks.is_empty() => {},
        }
    }
    if let Some(stop) = remote_cancel { stop.cancel(); }
    if let Some(stop) = pwnat_cancel { stop.cancel(); }
    let _ = tokio::time::timeout(Duration::from_secs(3), async { while pwnat_tasks.join_next().await.is_some() {} }).await;
    pwnat_tasks.shutdown().await;
    let _ = tokio::time::timeout(Duration::from_secs(3), async { while remote_tasks.join_next().await.is_some() {} }).await;
    remote_tasks.shutdown().await; tasks.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

    #[tokio::test(start_paused = true)]
    async fn failed_listener_restarts_with_backoff_and_cancellation_stops_retries() {
        let calls = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let task = tokio::spawn({
            let calls = calls.clone(); let cancel = cancel.clone();
            async move { supervise_listener(cancel, || {
                calls.fetch_add(1,Ordering::SeqCst);
                std::future::ready(())
            }).await }
        });
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst),1);
        for (seconds, expected) in [(1,2),(1,2),(1,3),(3,3),(1,4)] {
            tokio::time::advance(Duration::from_secs(seconds)).await;
            tokio::task::yield_now().await;
            assert_eq!(calls.load(Ordering::SeqCst),expected);
        }
        cancel.cancel();task.await.unwrap();
        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(calls.load(Ordering::SeqCst),4);
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_allows_active_listener_cleanup() {
        let cleaned = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let task = tokio::spawn({
            let cancel = cancel.clone();let cleaned = cleaned.clone();
            async move {
                supervise_listener(cancel.clone(),|| async {
                    cancel.cancelled().await;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    cleaned.fetch_add(1,Ordering::SeqCst);
                }).await;
            }
        });
        tokio::task::yield_now().await;
        cancel.cancel();task.await.unwrap();
        assert_eq!(cleaned.load(Ordering::SeqCst),1,"listener was dropped before cleanup");
    }
}
