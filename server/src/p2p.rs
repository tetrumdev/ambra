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

/// External ports to request, best first. Restrictive networks (schools, offices, hotels)
/// commonly allow only HTTPS ports, so those come before the listener's own port.
fn wanted_ports(internal: u16) -> Vec<u16> {
    let mut ports = vec![443, 8443, internal];
    ports.dedup();
    ports
}

/// Keeps a router port forwarded to the secure listener while remote networking is on.
/// Clients learn the resulting endpoints from their authorized session and dial them
/// directly when away from home, the same way an app reaches its vendor's server.
async fn forward_ports(network: SharedNetwork, internal: u16, cancel: CancellationToken) {
    const LEASE: Duration = Duration::from_secs(60 * 60);
    let mut held: Vec<(ambra_net::portmap::Gateway, u16)> = Vec::new();
    loop {
        let mut granted = Vec::new();
        let mut errors = Vec::new();
        let mut method = None;
        let gateways = tokio::select! { _ = cancel.cancelled() => break, g = ambra_net::portmap::discover() => g };
        for gateway in gateways {
            // Renew what this router already granted before asking for anything better.
            let mut order: Vec<u16> = held.iter().filter(|(g, _)| *g == gateway).map(|(_, p)| *p).collect();
            for port in wanted_ports(internal) { if !order.contains(&port) { order.push(port); } }
            for external in order {
                match gateway.map_tcp(external, internal, LEASE).await {
                    Ok(port) if port == external => {
                        granted.push((gateway.clone(), port));
                        // NAT-PMP keeps one mapping per internal port; asking again would move it.
                        if gateway.method() == "NAT-PMP" { break; }
                    }
                    Ok(port) => {
                        // NAT-PMP picked another port: release it and ask for the next preference,
                        // unless nothing better remains.
                        if external == internal { granted.push((gateway.clone(), port)); break; }
                        gateway.unmap_tcp(port, internal).await;
                    }
                    Err(error) => errors.push(format!("{} {external}: {error}", gateway.method())),
                }
            }
            if !granted.is_empty() { method = Some(gateway.method()); break; }
        }
        // Mappings no longer granted (another router, a changed address) are released.
        for (gateway, port) in held.drain(..) {
            if !granted.iter().any(|(g, p)| *g == gateway && *p == port) { gateway.unmap_tcp(port, internal).await; }
        }
        let endpoints: Vec<SocketAddr> = granted.iter().map(|(g, p)| SocketAddr::new(g.external_ip.into(), *p)).collect();
        let changed = {
            let mut status = network.port_mapping.write().unwrap_or_else(|p| p.into_inner());
            let changed = status.endpoints != endpoints;
            *status = ambra_net::portmap::Status {
                method,
                endpoints: endpoints.clone(),
                error: endpoints.is_empty().then(|| if errors.is_empty() { "No UPnP or NAT-PMP router found".to_owned() } else { errors.join("; ") }),
            };
            changed
        };
        if changed { eprintln!("Public TCP endpoints: {endpoints:?} ({})", method.unwrap_or("none")); }
        held = granted;
        let wait = if held.is_empty() { Duration::from_secs(60) } else { LEASE / 3 };
        tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(wait) => {} }
    }
    for (gateway, port) in held { let _ = tokio::time::timeout(Duration::from_secs(2), gateway.unmap_tcp(port, internal)).await; }
    *network.port_mapping.write().unwrap_or_else(|p| p.into_inner()) = Default::default();
}

pub async fn run(network: SharedNetwork, app: axum::Router, address: SocketAddr, cancel: CancellationToken) {
    let punch_config = ambra_net::tcp_punch::Config::from_env().map_err(|error| eprintln!("Native TCP punching unavailable: {error}")).ok();
    let port = network.config.read().unwrap_or_else(|p| p.into_inner()).secure_port;
    let secure = SocketAddr::new(address.ip(), port);
    let mut tasks = tokio::task::JoinSet::new();
    if !address.ip().is_loopback() { tasks.spawn(crate::discovery::run(network.clone(), cancel.clone())); }
    match ambra_net::lan::bind(secure).await {
        Ok(listener) => {
            if let Ok(mut listening) = network.secure_listening.write() { *listening = listener.local_addr().ok(); }
            let identity = network.identity.clone(); let app = app.clone(); let cancel = cancel.clone();
            let diagnostics = network.clone(); let admit = network.admit_public();
            tasks.spawn(async move {
                if let Err(error) = ambra_net::lan::serve(listener, identity, app, admit, cancel).await {
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
    let mut tailcat_config = None;
    let mut tailcat_cancel: Option<CancellationToken> = None;
    let mut tailcat_tasks = tokio::task::JoinSet::new();
    loop {
        let (enabled, pwnat_enabled, public_endpoint) = network.config.read()
            .map(|c| (c.p2p && !address.ip().is_loopback(), c.pwnat, c.public_endpoint)).unwrap_or_default();
        let tailcat_desired = network.config.read().map(|c| (enabled && c.tailcat, c.tailcat_derp_map_url.clone())).unwrap_or_default();
        if tailcat_config.as_ref() != Some(&tailcat_desired) {
            if let Some(stop) = tailcat_cancel.take() { stop.cancel(); }
            let _ = tokio::time::timeout(Duration::from_secs(3), async { while tailcat_tasks.join_next().await.is_some() {} }).await;
            tailcat_tasks.shutdown().await;
            *network.tailcat_state.write().unwrap_or_else(|p| p.into_inner()) = Default::default();
            tailcat_config = Some(tailcat_desired.clone());
            if tailcat_desired.0 {
                let stop = cancel.child_token(); tailcat_cancel = Some(stop.clone());
                let network = network.clone(); let app = app.clone();
                tailcat_tasks.spawn(async move {
                    supervise_listener(stop.clone(), || async {
                        let result = ambra_net::tailcat::serve(network.identity.clone(), crate::storage::data_path("tailcat-identity.json"), app.clone(), network.admit_public(), network.tailcat_state.clone(), tailcat_desired.1.clone(), stop.clone()).await;
                        let mut state = network.tailcat_state.write().unwrap_or_else(|p| p.into_inner());
                        state.address = None; state.status.running = false;
                        if !stop.is_cancelled() { state.status.error = Some(result.err().map_or_else(|| "Tailcat listener stopped".into(), |e| e.to_string())); }
                    }).await;
                });
            }
        }
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
                let admit = network.admit_remote();
                pwnat_tasks.spawn(async move {
                    supervise_listener(stop.clone(), || async {
                        let result = ambra_net::pwnat::serve(secure, identity.clone(), app.clone(), admit.clone(), stop.clone(), status.clone()).await;
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
            let pwnat_status = network.pwnat_status.clone(); let admit = network.admit_remote();
            // Explicit operator policy; native TCP punching never invokes router mapping.
            if std::env::var_os("AMBRA_DISABLE_PORT_MAPPING").is_none() {
                remote_tasks.spawn(forward_ports(network.clone(), port, stop.clone()));
            }
            if let Some(config) = punch_config.clone() {
                let identity = network.identity.clone(); let app = app.clone();
                let admit = network.admit_public(); let status = network.tcp_punch_status.clone();
                let cancel = stop.clone();
                remote_tasks.spawn(async move {
                    supervise_listener(cancel.clone(), || async {
                        let result = ambra_net::tcp_punch::serve(identity.clone(), app.clone(), admit.clone(), config.clone(), ambra_net::signaling::Signaling::defaults(), status.clone(), cancel.clone()).await;
                        if !cancel.is_cancelled() {
                            let mut status = status.write().unwrap_or_else(|p| p.into_inner());
                            status.running = false;
                            status.error = Some(result.err().map_or_else(|| "TCP punching listener stopped".into(), |e| e.to_string()));
                        }
                    }).await;
                });
            }
            remote_tasks.spawn(async move {
                supervise_listener(stop_dht.clone(), || async {
                    let result = ambra_net::hyperdht::serve(identity.clone(), dht_app.clone(), status.clone(), admit.clone(), stop_dht.clone(), Some(pwnat_status.clone())).await;
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
            Some(_) = tailcat_tasks.join_next(), if !tailcat_tasks.is_empty() => {},
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            Some(_) = remote_tasks.join_next(), if !remote_tasks.is_empty() => {},
            Some(_) = pwnat_tasks.join_next(), if !pwnat_tasks.is_empty() => {},
        }
    }
    if let Some(stop) = tailcat_cancel { stop.cancel(); }
    let _ = tokio::time::timeout(Duration::from_secs(3), async { while tailcat_tasks.join_next().await.is_some() {} }).await;
    tailcat_tasks.shutdown().await;
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
