use crate::{Identity, PublicKey, Result, hyperdht, lan, pwnat, tcp_punch, transport::HttpConnection};
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
    ConnectingPublic,
    ConnectingTcpPunch,
    Authenticating,
    ConnectedLocal,
    ConnectedPwnat,
    ConnectedHyperDHT,
    ConnectedPublic,
    ConnectedTcpPunch,
    Reconnecting,
    Failed,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum Method {
    Lan,
    Pwnat,
    HyperDHT,
    /// The server's router-forwarded TCP port, dialed directly over the Internet.
    Public,
    /// Nostr-signaled simultaneous TCP open, without router forwarding.
    TcpPunch,
}
/// LAN/public start together; HyperDHT/TCP punching race after the LAN grace.
pub const METHODS: [Method; 5] = [Method::Lan, Method::Public, Method::HyperDHT, Method::TcpPunch, Method::Pwnat];
impl Method {
    fn connected(self) -> ConnectionState {
        match self {
            Method::Lan => ConnectionState::ConnectedLocal,
            Method::Pwnat => ConnectionState::ConnectedPwnat,
            Method::HyperDHT => ConnectionState::ConnectedHyperDHT,
            Method::Public => ConnectionState::ConnectedPublic,
            Method::TcpPunch => ConnectionState::ConnectedTcpPunch,
        }
    }
    /// Away from home: worth checking periodically whether the LAN is back.
    fn away(self) -> bool {
        matches!(self, Method::HyperDHT | Method::Public | Method::Pwnat | Method::TcpPunch)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedServer {
    pub public_key: PublicKey,
    #[serde(default)]
    pub local_addresses: Vec<SocketAddr>,
    #[serde(default)]
    pub public_endpoint: Option<SocketAddr>,
    /// Router-forwarded public TCP endpoints of the encrypted listener.
    #[serde(default)]
    pub public_tcp: Vec<SocketAddr>,
}
#[derive(Clone, Debug)]
pub struct Timing {
    pub lan: Duration,
    pub pwnat: Duration,
    pub hyperdht: Duration,
    /// A whole public TCP race: every candidate's connect plus the Noise handshake.
    pub public: Duration,
    pub tcp_punch: Duration,
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
            public: Duration::from_secs(8),
            tcp_punch: Duration::from_secs(65),
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

const MAX_PUBLIC: usize = 8;
const PUBLIC_STAGGER: Duration = Duration::from_millis(200);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EndpointCache {
    server: PublicKey,
    public_tcp: Vec<SocketAddr>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionReply {
    #[serde(default)]
    public_endpoints: Vec<SocketAddr>,
}

pub struct ConnectionManager {
    pub selected: SelectedServer,
    identity: Identity,
    token: RwLock<Option<String>>,
    dht: hyperdht::Client,
    pwnat: pwnat::Client,
    /// Public TCP candidates, best first: pairing hints, the cache, and what the server reports.
    public_tcp: std::sync::Mutex<Vec<SocketAddr>>,
    endpoint_cache: std::sync::Mutex<Option<std::path::PathBuf>>,
    active: RwLock<Option<Arc<HttpConnection>>>,
    /// An encrypted HyperDHT session held open, unauthenticated, while another method is
    /// active. Authorizing it takes one request, so losing the LAN never waits for discovery.
    /// It is always newer than the active session, so the server lets it take over.
    standby: Mutex<Option<Arc<HttpConnection>>>,
    /// Bumped whenever the operating system reports a different network path.
    network: watch::Sender<u64>,
    /// Devices that move between networks keep the HyperDHT standby; desktops need not.
    roaming: std::sync::atomic::AtomicBool,
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
            public_tcp: std::sync::Mutex::new(selected.public_tcp.clone()),
            endpoint_cache: Default::default(),
            identity,
            selected,
            token: RwLock::new(token),
            active: RwLock::new(None),
            standby: Mutex::new(None),
            network: watch::channel(0).0,
            roaming: Default::default(),
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
        self.attempt_reporting(method, true).await
    }
    /// `report` is false for background work that must not disturb the visible state.
    async fn attempt_reporting(&self, method: Method, report: bool) -> Result<Arc<HttpConnection>> {
        let state = |state, method| if report { self.state(state, method, None) };
        let (io, pump) = match method {
            Method::Lan => {
                state(ConnectionState::DiscoveringLocal, None);
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
                state(ConnectionState::ConnectingLocal, Some(method));
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
                state(ConnectionState::ConnectingPwnat, Some(method));
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
                state(ConnectionState::ConnectingHyperDHT, Some(method));
                self.dht.connect(self.selected.public_key).await?
            }
            Method::TcpPunch => {
                state(ConnectionState::ConnectingTcpPunch, Some(method));
                if self.token.read().await.is_none() {
                    return Err("TCP punching admits already paired devices only".into());
                }
                tcp_punch::connect(self.identity.clone(), self.selected.public_key, self.cancel.clone()).await?
            }
            Method::Public => {
                state(ConnectionState::ConnectingPublic, Some(method));
                let (address, connected) = self.connect_public().await?;
                self.remember_public(address, None);
                connected
            }
        };
        HttpConnection::new(io, pump).await
    }

    /// Persist public endpoints across restarts, so a device that last saw the server at
    /// home can reach it from elsewhere without any discovery. Call before connecting.
    pub fn use_endpoint_cache(&self, path: std::path::PathBuf) {
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(cache) = serde_json::from_slice::<EndpointCache>(&bytes) {
                if cache.server == self.selected.public_key {
                    let mut known = self.public_tcp.lock().unwrap_or_else(|p| p.into_inner());
                    for address in cache.public_tcp.into_iter().rev() {
                        known.retain(|a| *a != address);
                        known.insert(0, address);
                    }
                    known.truncate(MAX_PUBLIC);
                }
            }
        }
        *self.endpoint_cache.lock().unwrap_or_else(|p| p.into_inner()) = Some(path);
    }

    /// Known public TCP endpoints, best first.
    pub fn public_endpoints(&self) -> Vec<SocketAddr> {
        self.public_tcp.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn save_endpoints(&self, endpoints: &[SocketAddr]) {
        let Some(path) = self.endpoint_cache.lock().unwrap_or_else(|p| p.into_inner()).clone() else { return };
        let cache = EndpointCache { server: self.selected.public_key, public_tcp: endpoints.to_vec() };
        let Ok(bytes) = serde_json::to_vec(&cache) else { return };
        let temporary = path.with_extension("tmp");
        if std::fs::write(&temporary, bytes).and_then(|_| std::fs::rename(&temporary, &path)).is_err() {
            tracing::debug!(path = %path.display(), "Could not save public endpoints");
        }
    }

    /// Records `winner` as the first candidate and, when given, replaces the rest with the
    /// server's current list (its public address can change while the device is away).
    fn remember_public(&self, winner: SocketAddr, reported: Option<Vec<SocketAddr>>) {
        let snapshot = {
            let mut known = self.public_tcp.lock().unwrap_or_else(|p| p.into_inner());
            let mut next = reported.unwrap_or_else(|| known.clone());
            next.retain(|address| !crate::lan::is_direct(address.ip()) && address.port() != 0);
            if next.contains(&winner) || known.contains(&winner) {
                next.retain(|a| *a != winner);
                next.insert(0, winner);
            }
            next.dedup();
            next.truncate(MAX_PUBLIC);
            let cached = self.endpoint_cache.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|path| path.exists());
            if *known == next && cached { return; }
            *known = next.clone();
            next
        };
        tracing::info!(endpoints = ?snapshot, "Public endpoints updated");
        self.save_endpoints(&snapshot);
    }

    /// Reads the server's router-forwarded endpoints from an authorized session reply.
    async fn learn_endpoints(&self, response: Response<Incoming>) {
        use http_body_util::BodyExt;
        let Ok(Ok(body)) = tokio::time::timeout(Duration::from_secs(5), http_body_util::Limited::new(response.into_body(), 16 * 1024).collect()).await else { return };
        let Ok(session) = serde_json::from_slice::<SessionReply>(&body.to_bytes()) else { return };
        if session.public_endpoints.is_empty() { return; }
        let current = self.public_endpoints();
        let winner = current.first().copied().filter(|a| session.public_endpoints.contains(a)).unwrap_or(session.public_endpoints[0]);
        self.remember_public(winner, Some(session.public_endpoints));
    }

    /// Happy-eyeballs over the public candidates: each starts a little after the previous
    /// one, and the first to finish the pinned Noise handshake wins. Restrictive networks
    /// often allow only TCP/443, so 443 on each known address is tried as well.
    async fn connect_public(&self) -> Result<(SocketAddr, (tokio::io::DuplexStream, crate::transport::Pump))> {
        let mut candidates = self.public_endpoints();
        let mut extra = Vec::new();
        for address in &candidates {
            let https = SocketAddr::new(address.ip(), 443);
            if !candidates.contains(&https) && !extra.contains(&https) { extra.push(https); }
        }
        candidates.extend(extra);
        if candidates.is_empty() {
            return Err("No public endpoint known yet; connect once at home to learn it".into());
        }
        let mut attempts = tokio::task::JoinSet::new();
        let mut errors = Vec::new();
        for (index, address) in candidates.into_iter().enumerate() {
            let identity = self.identity.clone();
            let key = self.selected.public_key;
            attempts.spawn(async move {
                tokio::time::sleep(PUBLIC_STAGGER * index as u32).await;
                (address, crate::lan::connect_public(address, key, &identity).await)
            });
        }
        while let Some(joined) = attempts.join_next().await {
            match joined {
                Ok((address, Ok(connected))) => {
                    tracing::info!(%address, "Public TCP endpoint answered");
                    return Ok((address, connected));
                }
                Ok((address, Err(error))) => errors.push(format!("{address}: {error}")),
                Err(_) => {}
            }
        }
        Err(errors.join(", ").into())
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
            self.learn_endpoints(response).await;
            self.state(method.connected(), Some(method), None);
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
                    let result = match owner.promote_standby().await {
                        Some(connection) => Ok(connection),
                        None => {
                            // A standby opened before this round is older than it; the server
                            // would refuse to let it take over, so it is replaced.
                            let result = owner.connect_round().await;
                            if result.is_ok() {
                                if let Some(old) = owner.standby.lock().await.take() { old.close(); }
                            }
                            result
                        }
                    };
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
        self.learn_endpoints(response).await;
        *self.token.write().await = Some(token);
        let method = self
            .status()
            .method
            .ok_or("Missing encrypted transport method")?;
        self.state(method.connected(), Some(method), None);
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
        if let Some(connection) = self.standby.lock().await.take() {
            connection.close();
        }
        self.dht.shutdown().await;
        self.pwnat.shutdown();
        self.state(ConnectionState::Offline, None, None);
    }

    /// Called when the operating system switches networks (Wi-Fi to Wi-Fi, Wi-Fi to cellular).
    /// Connections on the old path can hang for a long time instead of failing, so they are
    /// checked at once and replaced if they no longer answer.
    /// Keep a warm HyperDHT session beside the LAN, for phones that leave Wi-Fi mid-song.
    pub fn enable_roaming(&self) {
        self.roaming.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn network_changed(&self) {
        self.network.send_modify(|generation| *generation += 1);
    }

    /// For devices whose OS doesn't report network changes to the app (desktops): notices a
    /// changed set of addresses (Wi-Fi to Ethernet, joining a VPN, leaving home) within seconds.
    pub fn watch_network(self: &Arc<Self>) {
        let owner = Arc::downgrade(self);
        let cancel = self.cancel.clone();
        tokio::spawn(async move {
            let mut last = tokio::task::spawn_blocking(network_signature).await.unwrap_or_default();
            loop {
                tokio::select! {
                    () = cancel.cancelled() => return,
                    () = tokio::time::sleep(Duration::from_secs(2)) => {}
                }
                let current = tokio::task::spawn_blocking(network_signature).await.unwrap_or_default();
                if current == last { continue; }
                last = current;
                let Some(manager) = owner.upgrade() else { return };
                tracing::info!("Network addresses changed");
                manager.network_changed();
            }
        });
    }

    pub async fn run(&self) {
        let mut immediate_retry = true;
        let mut network = self.network.subscribe();
        loop {
            if self.cancel.is_cancelled() {
                break;
            }
            if let Ok(connection) = self.connect().await {
                let connected = tokio::time::Instant::now();
                let method = self.status().method;
                tokio::select! {
                    _ = self.cancel.cancelled() => break,
                    _ = connection.closed() => {}
                    _ = self.maintain(&connection, method, &mut network) => {}
                }
                // Switched to a better path while the old one still worked: nothing was lost.
                if self.active.read().await.as_ref().is_some_and(|active| !Arc::ptr_eq(active, &connection) && !active.is_closed()) {
                    continue;
                }
                connection.close();
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
            tokio::select! {
                _ = self.cancel.cancelled() => break,
                _ = tokio::time::sleep(self.timing.retry) => {}
                // A new network is worth trying straight away.
                _ = network.changed() => {}
            }
        }
        self.shutdown().await;
    }

    /// Runs beside a live connection and returns when it should be replaced: it stopped
    /// answering after a network change, or a LAN path came back while away from home.
    async fn maintain(&self, active: &Arc<HttpConnection>, method: Option<Method>, network: &mut watch::Receiver<u64>) {
        let authorized = self.token.read().await.is_some();
        let roaming = self.roaming.load(std::sync::atomic::Ordering::Relaxed);
        let away = method.is_some_and(Method::away);
        let mut upgrade = tokio::time::interval(Duration::from_secs(30));
        upgrade.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        upgrade.tick().await;
        loop {
            tokio::select! {
                _ = self.keep_standby(), if authorized && roaming && !away => {}
                changed = network.changed() => {
                    if changed.is_err() { std::future::pending::<()>().await; }
                    let (alive, standby) = tokio::join!(answers(active), async {
                        let standby = self.standby.lock().await.clone();
                        match standby { Some(standby) => Some((answers(&standby).await, standby)), None => None }
                    });
                    if let Some((false, dead)) = standby {
                        let mut slot = self.standby.lock().await;
                        if slot.as_ref().is_some_and(|current| Arc::ptr_eq(current, &dead)) { slot.take(); }
                        dead.close();
                    }
                    if !alive {
                        tracing::info!(?method, "Connection stopped answering after a network change");
                        return;
                    }
                    if away && authorized && self.upgrade(method).await { return; }
                }
                _ = upgrade.tick(), if away && authorized => {
                    if self.upgrade(method).await { return; }
                }
            }
        }
    }

    /// Keeps one warm, unauthenticated HyperDHT session. HTTP/2 keepalives hold its NAT
    /// mapping open and reveal when it dies, at which point it is quietly rebuilt.
    async fn keep_standby(&self) {
        loop {
            let current = self.standby.lock().await.clone();
            match current {
                Some(connection) if !connection.is_closed() => connection.closed().await,
                _ => {
                    let attempt = tokio::time::timeout(self.timing.hyperdht, self.attempt_reporting(Method::HyperDHT, false)).await;
                    match attempt {
                        Ok(Ok(connection)) => {
                            tracing::debug!("HyperDHT standby ready");
                            if let Some(old) = self.standby.lock().await.replace(connection) { old.close(); }
                        }
                        _ => tokio::time::sleep(self.timing.retry * 2).await,
                    }
                }
            }
        }
    }

    /// Authorizes the warm HyperDHT session in place of a lost connection.
    async fn promote_standby(&self) -> Option<Arc<HttpConnection>> {
        let standby = self.standby.lock().await.take()?;
        if standby.is_closed() || self.token.read().await.is_none() {
            standby.close();
            return None;
        }
        match tokio::time::timeout(Duration::from_secs(5), self.authenticate(&standby, Method::HyperDHT)).await {
            Ok(Ok(())) => {
                tracing::info!("Promoted HyperDHT standby without rediscovery");
                Some(standby)
            }
            _ => {
                standby.close();
                None
            }
        }
    }

    /// Moves to a better path when one answers: back to the LAN, or from HyperDHT to the
    /// forwarded TCP port. The new session is newer, so the server closes the old one once
    /// it is authorized.
    async fn upgrade(&self, current: Option<Method>) -> bool {
        if self.upgrade_to(Method::Lan, self.timing.lan).await { return true; }
        current == Some(Method::HyperDHT)
            && !self.public_endpoints().is_empty()
            && self.upgrade_to(Method::Public, self.timing.public).await
    }

    async fn upgrade_to(&self, method: Method, budget: Duration) -> bool {
        let Ok(Ok(connection)) = tokio::time::timeout(budget, self.attempt_reporting(method, false)).await else {
            return false;
        };
        if tokio::time::timeout(Duration::from_secs(5), self.authenticate(&connection, method)).await.is_ok_and(|result| result.is_ok()) {
            tracing::info!(?method, "Moved to a better connection");
            if let Some(old) = self.active.write().await.replace(connection) { retire(old); }
            true
        } else {
            connection.close();
            false
        }
    }
}

/// How long a replaced connection may finish the requests it already carries (a song
/// downloading, a long poll). New requests go to its replacement at once.
const RETIRE_AFTER: Duration = Duration::from_secs(30);

fn retire(connection: Arc<HttpConnection>) {
    tokio::spawn(async move {
        tokio::select! {
            () = connection.closed() => {}
            () = tokio::time::sleep(RETIRE_AFTER) => connection.close(),
        }
    });
}

/// The addresses this device has, to notice a changed network without help from the OS.
fn network_signature() -> Vec<(String, std::net::IpAddr)> {
    let mut addresses: Vec<_> = if_addrs::get_if_addrs().unwrap_or_default().into_iter()
        .filter(|interface| !interface.is_loopback())
        .map(|interface| { let ip = interface.ip(); (interface.name, ip) })
        .collect();
    addresses.sort();
    addresses
}

/// Whether a connection still carries requests. Public, so it works before authorization.
async fn answers(connection: &HttpConnection) -> bool {
    let Ok(request) = Request::builder().uri("/api/server/info").body(Body::empty()) else { return false };
    matches!(tokio::time::timeout(Duration::from_secs(2), connection.request(request)).await, Ok(Ok(_)))
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
            // LAN and the forwarded public port are both a single TCP dial, so they start
            // together: away from home the public path costs no head-start delay, and at
            // home the LAN answers in milliseconds and wins. HyperDHT (heavier, UDP)
            // waits for the LAN grace period.
            let lan = tokio::time::timeout(timing.lan, attempt(Method::Lan));
            tokio::pin!(lan);
            let public = tokio::time::timeout(timing.public, attempt(Method::Public));
            tokio::pin!(public);
            let (mut lan_done, mut public_done) = (false, false);
            let grace = tokio::time::sleep(timing.lan_grace);
            tokio::pin!(grace);
            loop {
                tokio::select! {
                    biased;
                    result = &mut lan, if !lan_done => {
                        lan_done = true;
                        match result {
                            Ok(Ok(connection)) => return Ok((Method::Lan, connection)),
                            result => errors.push(attempt_error(Method::Lan, result, timing.lan)),
                        }
                    }
                    result = &mut public, if !public_done => {
                        public_done = true;
                        match result {
                            Ok(Ok(connection)) => return Ok((Method::Public, connection)),
                            result => errors.push(attempt_error(Method::Public, result, timing.public)),
                        }
                    }
                    _ = &mut grace => break,
                }
                if lan_done && public_done { break; }
            }
            // HyperDHT hole punching covers routers without forwarding.
            let dht = tokio::time::timeout(timing.hyperdht, attempt(Method::HyperDHT));
            tokio::pin!(dht);
            let punch = tokio::time::timeout(timing.tcp_punch, attempt(Method::TcpPunch));
            tokio::pin!(punch);
            let (mut dht_done, mut punch_done) = (false, false);
            while !lan_done || !public_done || !dht_done || !punch_done {
                tokio::select! {
                    biased;
                    result = &mut lan, if !lan_done => {
                        lan_done = true;
                        match result {
                            Ok(Ok(connection)) => return Ok((Method::Lan, connection)),
                            result => errors.push(attempt_error(Method::Lan, result, timing.lan)),
                        }
                    }
                    result = &mut public, if !public_done => {
                        public_done = true;
                        match result {
                            Ok(Ok(connection)) => return Ok((Method::Public, connection)),
                            result => errors.push(attempt_error(Method::Public, result, timing.public)),
                        }
                    }
                    result = &mut punch, if !punch_done => {
                        punch_done = true;
                        match result {
                            Ok(Ok(connection)) => return Ok((Method::TcpPunch, connection)),
                            result => errors.push(attempt_error(Method::TcpPunch, result, timing.tcp_punch)),
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
    async fn lan_grace_avoids_dht_discovery_on_fast_lan() {
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
        // The public TCP dial starts alongside the LAN one; HyperDHT never starts.
        assert_eq!(result.0, Method::Lan);
        assert_eq!(visited, [Method::Lan, Method::Public]);
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
                        Method::Public | Method::TcpPunch => std::future::pending::<Result<()>>().await,
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
                    METHODS[..4].to_vec()
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
                    Method::Public => Err("no forwarded port".into()),
                    Method::TcpPunch => Err("no signaling".into()),
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

    #[tokio::test(start_paused = true)]
    async fn public_tcp_races_hyperdht_and_wins_when_faster() {
        let started = tokio::time::Instant::now();
        let result = raced(&Timing::default(), &CancellationToken::new(), false, |method| async move {
            match method {
                Method::Lan => Err("away".into()),
                Method::Public => { tokio::time::sleep(Duration::from_millis(80)).await; Ok(()) }
                Method::HyperDHT => { tokio::time::sleep(Duration::from_secs(3)).await; Ok(()) }
                Method::TcpPunch | Method::Pwnat => panic!("not needed"),
            }
        }).await.unwrap();
        assert_eq!(result.0, Method::Public);
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    #[tokio::test(start_paused = true)]
    async fn tcp_punch_races_dht_without_waiting_for_its_discovery_timeout() {
        let started = tokio::time::Instant::now();
        let result = raced(&Timing::default(), &CancellationToken::new(), false, |method| async move {
            match method {
                Method::Lan | Method::Public => Err("away".into()),
                Method::HyperDHT => std::future::pending::<Result<()>>().await,
                Method::TcpPunch => { tokio::time::sleep(Duration::from_millis(400)).await; Ok(()) }
                Method::Pwnat => panic!("not needed"),
            }
        }).await.unwrap();
        assert_eq!(result.0, Method::TcpPunch);
        assert!(started.elapsed() < Duration::from_secs(1));
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
