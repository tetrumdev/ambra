use crate::{Identity, PublicKey, Result, hyperdht, lan, pwnat, transport::HttpConnection};
use axum::body::Body;
use hyper::{Request, Response, body::Incoming};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::sync::{Mutex, RwLock, watch};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ConnectionState {
    Offline,
    DiscoveringLocal,
    ConnectingLocal,
    ConnectingPwnat,
    ConnectingHyperDHT,
    Authenticating,
    ConnectedLocal,
    ConnectedPwnat,
    ConnectedHyperDHT,
    Reconnecting,
    Failed,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum Method {
    Lan,
    Pwnat,
    HyperDHT,
}
/// The complete policy: no fourth strategy can be selected.
pub const METHODS: [Method; 3] = [Method::Lan, Method::HyperDHT, Method::Pwnat];
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedServer {
    pub public_key: PublicKey,
    #[serde(default)]
    pub local_addresses: Vec<SocketAddr>,
    #[serde(default)]
    pub public_endpoint: Option<SocketAddr>,
}
#[derive(Clone, Debug)]
pub struct Timing {
    pub lan: Duration,
    pub pwnat: Duration,
    pub hyperdht: Duration,
    pub retry: Duration,
    /// Prefer LAN for this long before starting public discovery.
    pub lan_grace: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            lan: Duration::from_secs(3),
            pwnat: Duration::from_secs(8),
            // Preserve the full signaling and restrictive-NAT retry window.
            hyperdht: Duration::from_secs(75),
            retry: Duration::from_secs(5),
            lan_grace: Duration::from_millis(250),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: ConnectionState,
    pub method: Option<Method>,
    pub server: PublicKey,
    pub error: Option<String>,
}

pub struct ConnectionManager {
    pub selected: SelectedServer,
    identity: Identity,
    token: RwLock<Option<String>>,
    dht: hyperdht::Client,
    pwnat: pwnat::Client,
    active: RwLock<Option<Arc<HttpConnection>>>,
    connecting: Mutex<Option<Flight>>,
    owner: Weak<Self>,
    status: watch::Sender<Status>,
    pub cancel: CancellationToken,
    timing: Timing,
}
// Waiters own receivers, not the attempt. Dropping any waiter never cancels
// establishment for other requests. Shutdown owns and joins the worker.
struct Flight {
    result: watch::Receiver<Option<std::result::Result<Arc<HttpConnection>, String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Flight {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl ConnectionManager {
    pub fn new(identity: Identity, selected: SelectedServer, token: Option<String>) -> Arc<Self> {
        Self::with_timing(identity, selected, token, Timing::default())
    }
    pub fn with_timing(
        identity: Identity,
        selected: SelectedServer,
        token: Option<String>,
        timing: Timing,
    ) -> Arc<Self> {
        let (status, _) = watch::channel(Status {
            state: ConnectionState::Offline,
            method: None,
            server: selected.public_key,
            error: None,
        });
        Arc::new_cyclic(|owner| Self {
            dht: hyperdht::Client::new(identity.clone()),
            pwnat: pwnat::Client::default(),
            identity,
            selected,
            token: RwLock::new(token),
            active: RwLock::new(None),
            connecting: Mutex::new(None),
            owner: owner.clone(),
            status,
            cancel: CancellationToken::new(),
            timing,
        })
    }
    pub fn status(&self) -> Status {
        self.status.borrow().clone()
    }
    pub fn subscribe(&self) -> watch::Receiver<Status> {
        self.status.subscribe()
    }
    fn state(&self, state: ConnectionState, method: Option<Method>, error: Option<String>) {
        tracing::info!(?state, ?method, server = %self.selected.public_key, ?error, "Native connection state");
        self.status.send_replace(Status {
            state,
            method,
            server: self.selected.public_key,
            error,
        });
    }
    async fn attempt(&self, method: Method) -> Result<Arc<HttpConnection>> {
        let (io, pump) = match method {
            Method::Lan => {
                self.state(ConnectionState::DiscoveringLocal, None, None);
                let mut addresses = self.selected.local_addresses.clone();
                // Cached hints race discovery, but only the selected key can authenticate.
                let discovery = lan::discover(Duration::from_millis(500));
                let mut attempts = tokio::task::JoinSet::new();
                for address in addresses.iter().copied().take(16) {
                    let identity = self.identity.clone();
                    let key = self.selected.public_key;
                    attempts.spawn(async move { lan::connect(address, key, &identity).await });
                }
                tokio::pin!(discovery);
                let mut discovered = false;
                self.state(ConnectionState::ConnectingLocal, Some(method), None);
                loop {
                    tokio::select! {
                        Some(result) = attempts.join_next(), if !attempts.is_empty() => { if let Ok(Ok(connected)) = result { break connected; } },
                        result = &mut discovery, if !discovered => {
                            discovered = true;
                            for server in result.unwrap_or_default() {
                                if server.info.public_key != Some(self.selected.public_key) || addresses.contains(&server.address) { continue; }
                                addresses.push(server.address);
                                let identity = self.identity.clone(); let key = self.selected.public_key;
                                attempts.spawn(async move { lan::connect(server.address, key, &identity).await });
                            }
                            // A restart can refuse cached hints before its listener binds.
                            // Retry once after discovery, only when no dial remains alive.
                            if attempts.is_empty() {
                                for address in addresses.iter().copied().take(16) {
                                    let identity = self.identity.clone(); let key = self.selected.public_key;
                                    attempts.spawn(async move { lan::connect(address, key, &identity).await });
                                }
                            }
                        },
                        else => return Err("Selected server is unavailable on LAN".into()),
                    }
                }
            }
            Method::Pwnat => {
                self.state(ConnectionState::ConnectingPwnat, Some(method), None);
                let capability = pwnat::capability();
                if !capability.available {
                    return Err(capability.reason.into());
                }
                let endpoint = match self.selected.public_endpoint {
                    Some(endpoint) => endpoint,
                    None => tokio::time::timeout(
                        Duration::from_secs(3),
                        self.dht.pwnat_endpoint(self.selected.public_key),
                    )
                    .await
                    .map_err(
                        |_| "Signed pwnat endpoint lookup timed out; no cached public endpoint",
                    )??,
                };
                self.pwnat
                    .connect(endpoint, self.selected.public_key, &self.identity)
                    .await?
            }
            Method::HyperDHT => {
                self.state(ConnectionState::ConnectingHyperDHT, Some(method), None);
                self.dht.connect(self.selected.public_key).await?
            }
        };
        HttpConnection::new(io, pump).await
    }

    async fn authenticate(&self, connection: &HttpConnection, method: Method) -> Result<()> {
        self.state(ConnectionState::Authenticating, Some(method), None);
        let started = std::time::Instant::now();
        // No successful state until device authorization succeeds. Enrollment keeps Authenticating.
        if let Some(token) = self.token.read().await.as_ref() {
            let response = connection
                .request(
                    Request::builder()
                        .uri("/api/network/session")
                        .header(hyper::header::AUTHORIZATION, format!("Bearer {token}"))
                        .body(Body::empty())?,
                )
                .await?;
            if !response.status().is_success() {
                return Err("Device authorization failed; pairing may have been revoked".into());
            }
            self.state(
                match method {
                    Method::Lan => ConnectionState::ConnectedLocal,
                    Method::Pwnat => ConnectionState::ConnectedPwnat,
                    Method::HyperDHT => ConnectionState::ConnectedHyperDHT,
                },
                Some(method),
                None,
            );
        }
        tracing::debug!(
            ?method,
            elapsed_ms = started.elapsed().as_millis(),
            "Device authentication complete"
        );
        Ok(())
    }

    async fn connect_round(&self) -> Result<Arc<HttpConnection>> {
        let started = std::time::Instant::now();
        let (method, connection) = raced(
            &self.timing,
            &self.cancel,
            pwnat::capability().available,
            |method| self.attempt(method),
        )
        .await?;
        // All competing encrypted transports are dropped before sending a bearer.
        // Only this session may change server authorization state.
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err("Connection cancelled".into()),
            result = tokio::time::timeout(Duration::from_secs(15), self.authenticate(&connection, method)) => result??,
        }
        tracing::info!(
            ?method,
            elapsed_ms = started.elapsed().as_millis(),
            "Connection round complete"
        );
        Ok(connection)
    }

    pub async fn connect(&self) -> Result<Arc<HttpConnection>> {
        let mut receiver = {
            let mut flight = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err("Connection cancelled".into()),
                flight = self.connecting.lock() => flight,
            };
            if self.cancel.is_cancelled() {
                return Err("Connection cancelled".into());
            }
            if let Some(connection) = self
                .active
                .read()
                .await
                .as_ref()
                .filter(|c| !c.is_closed())
                .cloned()
            {
                return Ok(connection);
            }
            if flight
                .as_ref()
                .is_none_or(|f| f.result.borrow().is_some() || f.task.is_finished())
            {
                self.active.write().await.take();
                let (result_tx, result) = watch::channel(None);
                let owner = self.owner.upgrade().ok_or("Connection manager dropped")?;
                let task = tokio::spawn(async move {
                    let result = owner.connect_round().await;
                    let result = match result {
                        Ok(connection) if !owner.cancel.is_cancelled() => {
                            *owner.active.write().await = Some(connection.clone());
                            Ok(connection)
                        }
                        Ok(connection) => {
                            connection.close();
                            Err("Connection cancelled".to_owned())
                        }
                        Err(error) => {
                            owner.state(ConnectionState::Offline, None, Some(error.to_string()));
                            Err(error.to_string())
                        }
                    };
                    result_tx.send_replace(Some(result));
                });
                *flight = Some(Flight { result, task });
            }
            flight.as_ref().unwrap().result.clone()
        };
        loop {
            if self.cancel.is_cancelled() {
                return Err("Connection cancelled".into());
            }
            if let Some(result) = receiver.borrow().clone() {
                return result.map_err(Into::into);
            }
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Err("Connection cancelled".into()),
                result = receiver.changed() => result.map_err(|_| "Connection worker stopped")?,
            }
        }
    }

    /// Promote enrollment on its existing encrypted session. Opening a second
    /// DHT connection races the server's one-live-session-per-device rule.
    pub async fn authorize(&self, token: String) -> Result<()> {
        let connection = self.connect().await?;
        let request = Request::builder()
            .uri("/api/network/session")
            .header(hyper::header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())?;
        let response = tokio::select! {
            _ = self.cancel.cancelled() => return Err("Connection cancelled".into()),
            result = tokio::time::timeout(Duration::from_secs(15), connection.request(request)) => result??,
        };
        if !response.status().is_success() {
            return Err("Device authorization failed; pairing may have been revoked".into());
        }
        *self.token.write().await = Some(token);
        let method = self
            .status()
            .method
            .ok_or("Missing encrypted transport method")?;
        self.state(
            match method {
                Method::Lan => ConnectionState::ConnectedLocal,
                Method::Pwnat => ConnectionState::ConnectedPwnat,
                Method::HyperDHT => ConnectionState::ConnectedHyperDHT,
            },
            Some(method),
            None,
        );
        Ok(())
    }

    pub async fn request(&self, mut request: Request<Body>) -> Result<Response<Incoming>> {
        let connection = self.connect().await?;
        request.headers_mut().remove(hyper::header::AUTHORIZATION);
        if let Some(token) = self.token.read().await.as_ref() {
            request.headers_mut().insert(
                hyper::header::AUTHORIZATION,
                format!("Bearer {token}").parse()?,
            );
        }
        // A request is sent once. Never replay a mutation after an ambiguous disconnect.
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => return Err("Connection cancelled".into()),
            result = tokio::time::timeout(Duration::from_secs(65), connection.request(request)) => result?,
        };
        if result
            .as_ref()
            .is_ok_and(|r| r.status() == hyper::StatusCode::UNAUTHORIZED)
        {
            self.state(
                ConnectionState::Failed,
                self.status().method,
                Some("Device authorization failed; pair this device again".into()),
            );
        }
        result
    }
    /// Cancel requests and release transports, including enrollment-only managers.
    pub async fn shutdown(&self) {
        self.cancel.cancel();
        let flight = self.connecting.lock().await.take();
        if let Some(mut flight) = flight {
            // Network work observes cancellation; join before closing shared state.
            let _ = (&mut flight.task).await;
        }
        if let Some(connection) = self.active.write().await.take() {
            connection.close();
        }
        self.dht.shutdown().await;
        self.pwnat.shutdown();
        self.state(ConnectionState::Offline, None, None);
    }

    pub async fn run(&self) {
        let mut immediate_retry = true;
        loop {
            if self.cancel.is_cancelled() {
                break;
            }
            if let Ok(connection) = self.connect().await {
                let connected = tokio::time::Instant::now();
                tokio::select! { _ = self.cancel.cancelled() => break, _ = connection.closed() => {} }
                self.state(ConnectionState::Reconnecting, None, None);
                // One immediate reconnect after interruption. Repeated brief
                // sessions must not create a hot loop against a flapping server.
                if connected.elapsed() >= self.timing.retry {
                    immediate_retry = true;
                }
                if immediate_retry {
                    immediate_retry = false;
                    continue;
                }
            }
            tokio::select! { _ = self.cancel.cancelled() => break, _ = tokio::time::sleep(self.timing.retry) => {} }
        }
        self.shutdown().await;
    }
}

impl ConnectionManager {
    /// Bounded JSON helper for enrollment/native commands. Music uses streaming requests.
    pub async fn json(
        &self,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        use http_body_util::BodyExt;
        let mut request = Request::builder().method(method).uri(path);
        if body.is_some() {
            request = request.header(hyper::header::CONTENT_TYPE, "application/json");
        }
        let response = self
            .request(request.body(body.map_or(Body::empty(), |v| Body::from(v.to_string())))?)
            .await?;
        let status = response.status();
        let bytes = http_body_util::Limited::new(response.into_body(), 64 * 1024)
            .collect()
            .await?
            .to_bytes();
        if !status.is_success() {
            return Err(format!(
                "Server answered {status}: {}",
                String::from_utf8_lossy(&bytes)
            )
            .into());
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
}

/// Race pinned encrypted transports. Device authorization starts only after
/// losers are dropped. Optional pwnat runs only after both native paths fail.
async fn raced<T, F, Fut>(
    timing: &Timing,
    cancel: &CancellationToken,
    pwnat_available: bool,
    mut attempt: F,
) -> Result<(Method, T)>
where
    F: FnMut(Method) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let operation = async {
        let mut errors = Vec::new();
        {
            let lan = tokio::time::timeout(timing.lan, attempt(Method::Lan));
            tokio::pin!(lan);
            let mut lan_done = false;
            tokio::select! {
                biased;
                result = &mut lan => {
                    lan_done = true;
                    match result {
                        Ok(Ok(connection)) => return Ok((Method::Lan, connection)),
                        result => errors.push(attempt_error(Method::Lan, result, timing.lan)),
                    }
                }
                _ = tokio::time::sleep(timing.lan_grace) => {}
            }
            let dht = tokio::time::timeout(timing.hyperdht, attempt(Method::HyperDHT));
            tokio::pin!(dht);
            let mut dht_done = false;
            while !lan_done || !dht_done {
                tokio::select! {
                    biased;
                    result = &mut lan, if !lan_done => {
                        lan_done = true;
                        match result {
                            Ok(Ok(connection)) => return Ok((Method::Lan, connection)),
                            result => errors.push(attempt_error(Method::Lan, result, timing.lan)),
                        }
                    }
                    result = &mut dht, if !dht_done => {
                        dht_done = true;
                        match result {
                            Ok(Ok(connection)) => return Ok((Method::HyperDHT, connection)),
                            result => errors.push(attempt_error(Method::HyperDHT, result, timing.hyperdht)),
                        }
                    }
                }
            }
        }
        if pwnat_available {
            match tokio::time::timeout(timing.pwnat, attempt(Method::Pwnat)).await {
                Ok(Ok(connection)) => return Ok((Method::Pwnat, connection)),
                result => errors.push(attempt_error(Method::Pwnat, result, timing.pwnat)),
            }
        }
        Err(errors.join("; ").into())
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Connection cancelled".into()),
        result = operation => result,
    }
}

fn attempt_error<T>(
    method: Method,
    result: std::result::Result<Result<T>, tokio::time::error::Elapsed>,
    timeout: Duration,
) -> String {
    let error = match result {
        Ok(Err(error)) => error.to_string(),
        Err(_) => format!("connection timed out after {:.1}s", timeout.as_secs_f64()),
        Ok(Ok(_)) => unreachable!(),
    };
    tracing::debug!(?method, timeout_seconds = timeout.as_secs_f64(), %error, "Transport attempt failed");
    format!("{method:?}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn lan_grace_avoids_public_discovery_on_fast_lan() {
        let mut visited = Vec::new();
        let result = raced(
            &Timing::default(),
            &CancellationToken::new(),
            true,
            |method| {
                visited.push(method);
                std::future::ready(Ok(()))
            },
        )
        .await
        .unwrap();
        assert_eq!(result.0, Method::Lan);
        assert_eq!(visited, [Method::Lan]);
    }

    #[tokio::test(start_paused = true)]
    async fn dht_does_not_wait_for_lan_timeout_and_loser_is_dropped() {
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct Guard(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let started = tokio::time::Instant::now();
        let result = raced(
            &Timing::default(),
            &CancellationToken::new(),
            true,
            |method| {
                let dropped = dropped.clone();
                async move {
                    match method {
                        Method::Lan => {
                            let _guard = Guard(dropped);
                            std::future::pending::<Result<()>>().await
                        }
                        Method::HyperDHT => Ok(()),
                        Method::Pwnat => panic!("pwnat must remain fallback"),
                    }
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(result.0, Method::HyperDHT);
        assert_eq!(started.elapsed(), Timing::default().lan_grace);
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test(start_paused = true)]
    async fn pwnat_is_capability_gated_and_last() {
        for available in [false, true] {
            let mut visited = Vec::new();
            let result = raced(
                &Timing::default(),
                &CancellationToken::new(),
                available,
                |method| {
                    visited.push(method);
                    std::future::ready(if method == Method::Pwnat {
                        Ok(())
                    } else {
                        Err("unavailable".into())
                    })
                },
            )
            .await;
            assert_eq!(result.is_ok(), available);
            assert_eq!(
                visited,
                if available {
                    METHODS.to_vec()
                } else {
                    METHODS[..2].to_vec()
                }
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn default_budget_allows_signaling_and_full_holepunch_window() {
        let result = raced(
            &Timing::default(),
            &CancellationToken::new(),
            true,
            |method| async move {
                match method {
                    Method::Lan => Err("LAN down".into()),
                    Method::HyperDHT => {
                        // A slow handshake followed by a successful late punch must not
                        // be cancelled by the manager's shorter, outer timeout.
                        tokio::time::sleep(Duration::from_secs(10 + 30 + 5)).await;
                        Ok(())
                    }
                    Method::Pwnat => panic!("must not fall back before the punch window ends"),
                }
            },
        )
        .await;
        assert!(result.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn failures_retain_each_method_and_timeout_budget() {
        let result: Result<(Method, ())> = raced(
            &Timing::default(),
            &CancellationToken::new(),
            true,
            |method| async move {
                match method {
                    Method::HyperDHT => std::future::pending().await,
                    _ => Err("unavailable".into()),
                }
            },
        )
        .await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("Lan: unavailable"));
        assert!(error.contains("HyperDHT: connection timed out after 75.0s"));
        assert!(error.contains("Pwnat: unavailable"));
    }

    #[tokio::test]
    async fn cancellation_prevents_any_attempt() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result: Result<(Method, ())> = raced(&Timing::default(), &cancel, true, |_| async {
            panic!("must not start")
        })
        .await;
        assert!(result.unwrap_err().to_string().contains("cancelled"));
    }
}
