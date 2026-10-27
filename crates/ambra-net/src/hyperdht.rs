use crate::{Identity, PublicKey, Result, pwnat, transport};
use libudx::UdxRuntime;
use peeroxide_dht::hyperdht::{self, HyperDhtConfig, HyperDhtHandle};
use std::{sync::Arc, time::Duration};
use tokio::{sync::Mutex, task::JoinHandle};
use tokio_util::sync::CancellationToken;

/// One lazy client node per manager, never one node per API call.
pub struct Client {
    identity: Identity,
    node: Mutex<Option<Node>>,
}
struct Node {
    runtime: UdxRuntime,
    handle: HyperDhtHandle,
    task: JoinHandle<std::result::Result<(), peeroxide_dht::hyperdht::HyperDhtError>>,
    executor: tokio::runtime::Handle,
}
impl Drop for Node {
    fn drop(&mut self) {
        // Destroy the node before aborting its owner: dropping JoinHandle alone detaches children.
        let handle = self.handle.clone();
        let abort = self.task.abort_handle();
        self.executor.spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(2), handle.destroy()).await;
            abort.abort();
        });
    }
}
impl Client {
    pub fn new(identity: Identity) -> Self {
        Self {
            identity,
            node: Mutex::new(None),
        }
    }
    async fn ready(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Node>>> {
        let mut node = self.node.lock().await;
        if node.is_none() {
            let runtime = UdxRuntime::new()?;
            let (task, handle, _events) =
                hyperdht::spawn(&runtime, HyperDhtConfig::with_public_bootstrap()).await?;
            *node = Some(Node {
                runtime,
                handle,
                task,
                executor: tokio::runtime::Handle::current(),
            });
        }
        node.as_ref()
            .ok_or("DHT failed to initialize")?
            .handle
            .bootstrapped()
            .await?;
        Ok(node)
    }
    /// The dependency verifies the mutable-record signature against the selected server key.
    /// A DHT/UDX connection is not required to retrieve this small control record.
    pub async fn pwnat_endpoint(&self, key: PublicKey) -> Result<std::net::SocketAddr> {
        let node = self.ready().await?;
        let node = node.as_ref().ok_or("DHT failed to initialize")?;
        let record = node.handle.mutable_get(&key.0, 0).await?
            .ok_or("No signed public pwnat endpoint; server must opt in and publish through HyperDHT, or supply a public pairing hint")?;
        pwnat::EndpointRecord::decode(&record.value, pwnat::unix_seconds()?)
    }
    pub async fn connect(
        &self,
        key: PublicKey,
    ) -> Result<(tokio::io::DuplexStream, transport::Pump)> {
        tracing::debug!(server = %key, "HyperDHT bootstrap started");
        let node = self.ready().await?;
        let node = node.as_ref().ok_or("DHT failed to initialize")?;
        tracing::debug!(server = %key, "HyperDHT bootstrap complete; resolving public key");
        let mut options = peeroxide_dht::hyperdht::ConnectOpts::default();
        options.local_connection = false;
        let connection = node
            .handle
            .connect_with_options(
                &self.identity.key_pair(),
                key.0,
                &[],
                &node.runtime,
                options,
            )
            .await?;
        if connection.remote_public_key != key.0 || connection.remote_addr.is_none() {
            return Err("DHT identity or direct endpoint missing".into());
        }
        tracing::info!(peer = %key, endpoint = ?connection.remote_addr, "HyperDHT authenticated direct encrypted stream; data relay disabled");
        // Vendored connect rejects relay_through before it can open a data stream.
        let socket = connection.socket.clone();
        Ok(transport::adapt(connection.stream, Some(Box::new(socket))))
    }
    pub async fn shutdown(&self) {
        if let Some(node) = self.node.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), node.handle.destroy()).await;
        }
    }
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub announced: bool,
    pub error: Option<String>,
}
pub type SharedStatus = Arc<std::sync::RwLock<Status>>;

/// Upstream acceptor handles passive NAT rounds. No client topic swarm is started.
pub async fn serve(
    identity: Identity,
    app: axum::Router,
    status: SharedStatus,
    cancel: CancellationToken,
    pwnat_status: Option<pwnat::SharedStatus>,
) -> Result<()> {
    let mut config = peeroxide::SwarmConfig::with_public_bootstrap();
    config.key_pair = Some(identity.key_pair());
    config.max_peers = 64;
    config.max_parallel = 2;
    config.local_connection = false;
    config.relay_through = None;
    config.relay_address = None;
    let (task, swarm, mut incoming) = peeroxide::spawn(config).await?;
    if let Ok(mut status) = status.write() {
        status.running = true;
    }
    let target = peeroxide_dht::crypto::hash(&identity.public_key().0);
    swarm.dht().register_server(&target);
    let dht = swarm.dht().clone();
    let key_pair = identity.key_pair();
    let announcement_status = status.clone();
    let announcement_cancel = cancel.clone();
    let announce = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! { _ = announcement_cancel.cancelled() => break, _ = interval.tick() => {} }
            let operation = async {
                dht.bootstrapped().await?;
                let result = dht.announce(target, &key_pair, &[]).await?;
                if result.closest_nodes.is_empty() {
                    return Err("No DHT node acknowledged the announcement".into());
                }
                Ok::<_, crate::Error>(())
            };
            let result = tokio::select! { _ = announcement_cancel.cancelled() => break, result = tokio::time::timeout(Duration::from_secs(30), operation) => result };
            let announced = matches!(result, Ok(Ok(())));
            if let Ok(mut status) = announcement_status.write() {
                status.announced = announced;
                status.error = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(error.to_string()),
                    Err(_) => Some("Public DHT announcement timed out".into()),
                };
            }
            if !announced {
                continue;
            }
            // This record uses the server's existing DHT identity and public bootstrap.
            // The DHT port is never presented as the QUIC port. This bounded pwnat
            // protocol still requires port-preserving NAT unless an operator supplies
            // the actual mapped server port. Observed IPs are only candidate hints.
            let Some(shared) = &pwnat_status else {
                continue;
            };
            let snapshot = shared.read().unwrap_or_else(|p| p.into_inner()).clone();
            if !snapshot.running {
                continue;
            }
            let publication = async {
                let endpoint = if let Some(endpoint) = snapshot.configured_endpoint {
                    endpoint
                } else {
                    let observed = dht
                        .remote_address()
                        .await?
                        .ok_or("DHT has no public IPv4 observation yet")?;
                    std::net::SocketAddr::new(
                        observed.host.parse()?,
                        snapshot.listening.ok_or("pwnat listener missing")?.port(),
                    )
                };
                let now = pwnat::unix_seconds()?;
                let value = pwnat::EndpointRecord::encode(endpoint, now)?;
                let stored = dht.mutable_put(&key_pair, &value, now).await?;
                if stored.closest_nodes.is_empty()
                    || stored.commit_timeouts as usize >= stored.closest_nodes.len()
                {
                    return Err("No DHT node acknowledged the pwnat endpoint record".into());
                }
                Ok::<_, crate::Error>(endpoint)
            };
            let publication = tokio::select! {
                _ = announcement_cancel.cancelled() => break,
                result = tokio::time::timeout(Duration::from_secs(10), publication) => result.unwrap_or_else(|_| Err("pwnat endpoint publication timed out".into())),
            };
            let mut status = shared.write().unwrap_or_else(|p| p.into_inner());
            if !status.running
                || status.listening != snapshot.listening
                || status.configured_endpoint != snapshot.configured_endpoint
            {
                continue;
            }
            match publication {
                Ok(endpoint) => {
                    status.public_endpoint = Some(endpoint);
                    status.discovery_error = None;
                    tracing::info!(%endpoint, "Published signed pwnat candidate; UDP port preservation remains required");
                }
                Err(error) => {
                    status.public_endpoint = None;
                    status.discovery_error = Some(error.to_string());
                    tracing::warn!(%error, "pwnat endpoint publication failed");
                }
            }
        }
    });
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            connection = incoming.recv() => {
                let Some(connection) = connection else { break; };
                if tasks.len() >= 64 { swarm.release_peer(connection.peer.remote_public_key).await; continue; }
                let Some(address) = connection.peer.remote_addr.filter(|a| !peeroxide_dht::address_policy::is_overlay(a.ip())) else {
                    eprintln!("Rejecting HyperDHT session without a native peer endpoint");
                    swarm.release_peer(connection.peer.remote_public_key).await;
                    continue;
                };
                tracing::info!(peer = %PublicKey(connection.peer.remote_public_key), endpoint = %address, "HyperDHT accepted authenticated direct encrypted stream; data relay disabled");
                let peer = transport::RemotePeer { public_key: PublicKey(connection.peer.remote_public_key), address, session: Arc::new(()) };
                let socket = connection.peer.socket.clone();
                let (io, pump) = transport::adapt(connection.peer.stream, Some(Box::new(socket)));
                let app = app.clone(); let cancel = cancel.clone(); let swarm = swarm.clone(); let key = peer.public_key;
                tasks.spawn(async move { if let Err(error) = transport::serve(io, pump, peer, app, cancel).await { eprintln!("HyperDHT HTTP session closed: {error:?}"); } swarm.release_peer(key.0).await; });
            }
        }
    }
    tasks.shutdown().await;
    announce.abort();
    swarm.dht().unregister_server(&target);
    let _ = tokio::time::timeout(
        Duration::from_millis(500),
        swarm.dht().unannounce(target, &identity.key_pair()),
    )
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(2), swarm.destroy()).await;
    task.abort();
    if let Ok(mut status) = status.write() {
        status.running = false;
        status.announced = false;
    }
    Ok(())
}
