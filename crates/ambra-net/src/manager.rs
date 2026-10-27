use crate::{Identity, PublicKey, Result, hyperdht, lan, pwnat, transport::HttpConnection};
use axum::body::Body;
use hyper::{Request, Response, body::Incoming};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc, time::Duration};
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
pub const METHODS: [Method; 3] = [Method::Lan, Method::Pwnat, Method::HyperDHT];
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
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            lan: Duration::from_secs(3),
            pwnat: Duration::from_secs(4),
            hyperdht: Duration::from_secs(15),
            retry: Duration::from_secs(5),
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
    token: Option<String>,
    dht: hyperdht::Client,
    active: RwLock<Option<Arc<HttpConnection>>>,
    connecting: Mutex<()>,
    status: watch::Sender<Status>,
    pub cancel: CancellationToken,
    timing: Timing,
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
        Arc::new(Self {
            dht: hyperdht::Client::new(identity.clone()),
            identity,
            selected,
            token,
            active: RwLock::new(None),
            connecting: Mutex::new(()),
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
                        },
                        else => return Err("Selected server is unavailable on LAN".into()),
                    }
                }
            }
            Method::Pwnat => {
                self.state(ConnectionState::ConnectingPwnat, Some(method), None);
                let endpoint = self
                    .selected
                    .public_endpoint
                    .ok_or("No cached public endpoint; pwnat skipped")?;
                pwnat::connect(endpoint, self.selected.public_key, &self.identity).await?
            }
            Method::HyperDHT => {
                self.state(ConnectionState::ConnectingHyperDHT, Some(method), None);
                self.dht.connect(self.selected.public_key).await?
            }
        };
        self.state(ConnectionState::Authenticating, Some(method), None);
        let connection = HttpConnection::new(io, pump).await?;
        // No successful state until device authorization succeeds. Enrollment keeps Authenticating.
        if let Some(token) = &self.token {
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
        Ok(connection)
    }
    pub async fn connect(&self) -> Result<Arc<HttpConnection>> {
        let _lock = tokio::select! { biased; _ = self.cancel.cancelled() => return Err("Connection cancelled".into()), lock = self.connecting.lock() => lock };
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
        self.active.write().await.take();
        match ordered(&self.timing, &self.cancel, |method| self.attempt(method)).await {
            Ok(connection) => {
                *self.active.write().await = Some(connection.clone());
                Ok(connection)
            }
            Err(error) => {
                self.dht.shutdown().await;
                self.state(ConnectionState::Offline, None, Some(error.to_string()));
                Err(error)
            }
        }
    }

    pub async fn request(&self, mut request: Request<Body>) -> Result<Response<Incoming>> {
        let connection = self.connect().await?;
        request.headers_mut().remove(hyper::header::AUTHORIZATION);
        if let Some(token) = &self.token {
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
        let _connecting = self.connecting.lock().await;
        if let Some(connection) = self.active.write().await.take() {
            connection.close();
        }
        self.dht.shutdown().await;
        self.state(ConnectionState::Offline, None, None);
    }

    pub async fn run(&self) {
        loop {
            if self.cancel.is_cancelled() {
                break;
            }
            if let Ok(connection) = self.connect().await {
                tokio::select! { _ = self.cancel.cancelled() => break, _ = connection.closed() => {} }
                self.state(ConnectionState::Reconnecting, None, None);
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

async fn ordered<T, F, Fut>(
    timing: &Timing,
    cancel: &CancellationToken,
    mut attempt: F,
) -> Result<T>
where
    F: FnMut(Method) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut errors = Vec::new();
    for method in METHODS {
        let timeout = match method {
            Method::Lan => timing.lan,
            Method::Pwnat => timing.pwnat,
            Method::HyperDHT => timing.hyperdht,
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("Connection cancelled".into()),
            result = tokio::time::timeout(timeout, attempt(method)) => result,
        };
        match result {
            Ok(Ok(connection)) => return Ok(connection),
            Ok(Err(error)) => errors.push(format!("{method:?}: {error}")),
            Err(_) => errors.push(format!("{method:?}: connection timed out")),
        }
    }
    Err(errors.join("; ").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn policy_is_lan_then_pwnat_then_hyperdht_then_offline() {
        for success in [
            Some(Method::Lan),
            Some(Method::Pwnat),
            Some(Method::HyperDHT),
            None,
        ] {
            let mut visited = Vec::new();
            let result = ordered(&Timing::default(), &CancellationToken::new(), |method| {
                visited.push(method);
                std::future::ready(if Some(method) == success {
                    Ok(())
                } else {
                    Err("unavailable or unauthorized".into())
                })
            })
            .await;
            assert_eq!(result.is_ok(), success.is_some());
            let count = success.map_or(3, |m| METHODS.iter().position(|s| *s == m).unwrap() + 1);
            assert_eq!(visited, METHODS[..count]);
        }
    }
    #[tokio::test(start_paused = true)]
    async fn timeout_drops_attempt_and_moves_to_final_method() {
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct Guard(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let result = ordered(&Timing::default(), &CancellationToken::new(), |method| {
            let dropped = dropped.clone();
            async move {
                match method {
                    Method::Lan => Err("LAN down".into()),
                    Method::Pwnat => {
                        let _guard = Guard(dropped);
                        std::future::pending::<Result<()>>().await
                    }
                    Method::HyperDHT => Ok(()),
                }
            }
        })
        .await;
        assert!(result.is_ok());
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    }
    #[tokio::test]
    async fn cancellation_prevents_any_attempt() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result: Result<()> = ordered(&Timing::default(), &cancel, |_| async {
            panic!("must not start")
        })
        .await;
        assert!(result.unwrap_err().to_string().contains("cancelled"));
    }
}
