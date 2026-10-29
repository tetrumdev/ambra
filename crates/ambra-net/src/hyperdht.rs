use crate::{Identity, PublicKey, Result, pwnat, transport};
use libudx::UdxRuntime;
use peeroxide_dht::hyperdht::{self, HyperDhtConfig, HyperDhtHandle};
use std::{sync::Arc, time::Duration};
use tokio::{sync::Mutex, task::JoinHandle};
use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};

/// One lazy client node per manager, never one node per API call.
pub struct Client {
    identity: Identity,
    node: Mutex<Option<Node>>,
    config: HyperDhtConfig,
}
struct Node {
    runtime: UdxRuntime,
    handle: HyperDhtHandle,
    task: JoinHandle<std::result::Result<(), peeroxide_dht::hyperdht::HyperDhtError>>,
    network: Vec<(String, std::net::IpAddr)>,
}
impl Drop for Node {
    fn drop(&mut self) {
        // The supervisor owns abort-on-drop guards for both DHT tasks.
        self.task.abort();
    }
}

fn native_network() -> Vec<(String, std::net::IpAddr)> {
    let mut addresses: Vec<_> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|interface| {
            peeroxide_dht::address_policy::is_native_interface(&interface.name, interface.ip())
        })
        .map(|interface| (interface.name, interface.addr.ip()))
        .collect();
    addresses.sort_unstable();
    addresses.dedup();
    addresses
}

impl Node {
    async fn shutdown(&mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(2), self.handle.destroy()).await;
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}
impl Client {
    pub fn new(identity: Identity) -> Self {
        Self {
            identity,
            node: Mutex::new(None),
            config: HyperDhtConfig::with_public_bootstrap(),
        }
    }
    async fn ready(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Node>>> {
        let mut node = self.node.lock().await;
        let network = native_network();
        if node
            .as_ref()
            .is_some_and(|node| node.task.is_finished() || node.network != network)
        {
            tracing::info!("Replacing failed DHT node or changed native network");
            if let Some(mut old) = node.take() {
                old.shutdown().await;
            }
        }
        if node.is_none() {
            let started = std::time::Instant::now();
            let runtime = UdxRuntime::new()?;
            let (task, handle, _events) =
                hyperdht::spawn(&runtime, self.config.clone()).await?;
            *node = Some(Node {
                runtime,
                handle,
                task,
                network,
            });
            tracing::debug!(
                elapsed_ms = started.elapsed().as_millis(),
                "DHT node started"
            );
        }
        let started = std::time::Instant::now();
        let result = node.as_ref()
            .ok_or("DHT failed to initialize")?
            .handle
            .bootstrapped()
            .await;
        if let Err(error) = result {
            if let Some(mut failed) = node.take() {
                failed.shutdown().await;
            }
            return Err(error.into());
        }
        tracing::debug!(
            elapsed_ms = started.elapsed().as_millis(),
            "DHT bootstrap ready"
        );
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
        let started = std::time::Instant::now();
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
        tracing::info!(peer = %key, endpoint = ?connection.remote_addr, elapsed_ms = started.elapsed().as_millis(), "HyperDHT authenticated direct encrypted stream; data relay disabled");
        // Vendored connect rejects relay_through before it can open a data stream.
        let socket = connection.socket.clone();
        Ok(transport::adapt(connection.stream, Some(Box::new(socket))))
    }
    pub async fn shutdown(&self) {
        if let Some(mut node) = self.node.lock().await.take() {
            node.shutdown().await;
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
    serve_with_config(identity,app,status,cancel,pwnat_status,config).await
}

async fn serve_with_config(
    identity: Identity,
    app: axum::Router,
    status: SharedStatus,
    cancel: CancellationToken,
    pwnat_status: Option<pwnat::SharedStatus>,
    config: peeroxide::SwarmConfig,
) -> Result<()> {
    let (task, swarm, mut incoming) = peeroxide::spawn(config).await?;
    let mut task = AbortOnDropHandle::new(task);
    if let Ok(mut status) = status.write() {
        status.running = true;
        status.announced = false;
        status.error = None;
    }
    // Bootstrap failure is terminal for this actor. Retrying announcements on
    // the same failed node can never recover; return to the server's supervisor
    // so it can allocate fresh sockets after backoff. The acceptor already runs
    // independently, and LAN startup does not wait on this task.
    let bootstrap = tokio::select! {
        _ = cancel.cancelled() => None,
        result = tokio::time::timeout(Duration::from_secs(30),swarm.dht().bootstrapped()) => Some(result),
    };
    if !matches!(bootstrap,Some(Ok(Ok(())))) {
        let error = match bootstrap {
            Some(Ok(Err(error))) => Some(error.to_string()),
            Some(Err(_)) => Some("HyperDHT bootstrap timed out".to_owned()),
            _ => None,
        };
        if let Ok(mut status) = status.write() {
            status.running = false;
            status.error = error.clone();
        }
        let _ = tokio::time::timeout(Duration::from_secs(2),swarm.destroy()).await;
        task.abort();
        let _ = (&mut task).await;
        return error.map_or(Ok(()),|error|Err(error.into()));
    }
    let target = peeroxide_dht::crypto::hash(&identity.public_key().0);
    swarm.dht().register_server(&target);
    let dht = swarm.dht().clone();
    let key_pair = identity.key_pair();
    let announcement_status = status.clone();
    let announcement_cancel = cancel.clone();
    let mut announce = AbortOnDropHandle::new(tokio::spawn(async move {
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
    }));
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            connection = incoming.recv() => {
                let Some(connection) = connection else { break; };
                let generation = connection.generation();
                if tasks.len() >= 64 { swarm.release_peer(connection.peer.remote_public_key, generation).await; continue; }
                let Some(address) = connection.peer.remote_addr.filter(|a| !peeroxide_dht::address_policy::is_overlay(a.ip())) else {
                    eprintln!("Rejecting HyperDHT session without a native peer endpoint");
                    swarm.release_peer(connection.peer.remote_public_key, generation).await;
                    continue;
                };
                tracing::info!(peer = %PublicKey(connection.peer.remote_public_key), endpoint = %address, "HyperDHT accepted authenticated direct encrypted stream; data relay disabled");
                let peer = transport::RemotePeer { public_key: PublicKey(connection.peer.remote_public_key), address, session: Arc::new(transport::Session::default()) };
                let socket = connection.peer.socket.clone();
                let (io, pump) = transport::adapt(connection.peer.stream, Some(Box::new(socket)));
                let app = app.clone(); let cancel = cancel.clone(); let swarm = swarm.clone(); let key = peer.public_key;
                tasks.spawn(async move { if let Err(error) = transport::serve(io, pump, peer, app, cancel).await { eprintln!("HyperDHT HTTP session closed: {error:?}"); } swarm.release_peer(key.0, generation).await; });
            }
        }
    }
    tasks.shutdown().await;
    announce.abort();
    let _ = (&mut announce).await;
    swarm.dht().unregister_server(&target);
    let _ = tokio::time::timeout(
        Duration::from_millis(500),
        swarm.dht().unannounce(target, &identity.key_pair()),
    )
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(2), swarm.destroy()).await;
    task.abort();
    let _ = (&mut task).await;
    if let Ok(mut status) = status.write() {
        status.running = false;
        status.announced = false;
    }
    Ok(())
}

#[cfg(test)]
mod client_tests {
    use super::*;

    #[tokio::test]
    async fn server_does_not_keep_a_terminally_failed_bootstrap_node_alive() {
        let reserved = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let address = reserved.local_addr().unwrap();
        drop(reserved);
        let identity = Identity::generate().unwrap();
        let mut config = peeroxide::SwarmConfig::default();
        config.key_pair = Some(identity.key_pair());
        config.dht.dht.bootstrap = vec![address.to_string()];
        let status = Arc::new(std::sync::RwLock::new(Status::default()));
        let result = tokio::time::timeout(Duration::from_secs(8),serve_with_config(
            identity, axum::Router::new(), status.clone(), CancellationToken::new(), None, config,
        )).await.expect("failed bootstrap must return to the listener supervisor");
        assert!(result.is_err());
        let status = status.read().unwrap();
        assert!(!status.running && !status.announced);
        assert!(status.error.as_ref().is_some_and(|e|e.contains("bootstrap")));
    }

    fn isolated_client() -> Client {
        Client {
            identity: Identity::generate().unwrap(),
            node: Mutex::new(None),
            config: HyperDhtConfig::default(),
        }
    }

    #[tokio::test]
    async fn failed_bootstrap_discards_node_and_recovers_with_fresh_sockets() {
        let silent = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = silent.local_addr().unwrap().port();
        let mut client = isolated_client();
        client.config.dht.bootstrap = vec![format!("127.0.0.1:{port}")];
        assert!(client.ready().await.is_err());
        assert!(client.node.lock().await.is_none());

        drop(silent);
        let runtime = UdxRuntime::new().unwrap();
        let mut config = peeroxide_dht::rpc::DhtConfig::default();
        config.host = "127.0.0.1".into();
        config.port = port;
        config.ephemeral = Some(false);
        config.firewalled = false;
        let (task, bootstrap) = peeroxide_dht::rpc::spawn(&runtime, config).await.unwrap();
        bootstrap.bootstrapped().await.unwrap();
        let node = client.ready().await.unwrap();
        assert!(
            node.as_ref()
                .unwrap()
                .handle
                .dht()
                .table_size()
                .await
                .unwrap()
                > 0
        );
        drop(node);
        client.shutdown().await;
        bootstrap.destroy().await.unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn failed_peer_lookup_reuses_healthy_node() {
        let client = isolated_client();
        let key = Identity::generate().unwrap().public_key();
        assert!(client.connect(key).await.is_err());
        let port = client
            .node
            .lock()
            .await
            .as_ref()
            .unwrap()
            .handle
            .dht()
            .local_port()
            .await
            .unwrap();
        assert!(client.connect(key).await.is_err());
        {
            let guard = client.node.lock().await;
            let node = guard.as_ref().unwrap();
            assert!(!node.task.is_finished());
            assert_eq!(port, node.handle.dht().local_port().await.unwrap());
        }
        client.shutdown().await;
    }

    #[tokio::test]
    async fn changed_network_replaces_stale_routing_state() {
        let client = isolated_client();
        let old = {
            let mut node = client.ready().await.unwrap();
            let node = node.as_mut().unwrap();
            // Simulate the fingerprint recorded on a previous native network.
            node.network
                .push(("previous-network".into(), "192.0.2.9".parse().unwrap()));
            node.handle.clone()
        };
        let replacement = client.ready().await.unwrap();
        assert_eq!(replacement.as_ref().unwrap().network, native_network());
        assert!(old.bootstrapped().await.is_err());
        drop(replacement);
        client.shutdown().await;
    }

    #[tokio::test]
    async fn failed_node_is_replaced_and_shutdown_closes_owner() {
        let client = isolated_client();
        let old = {
            let node = client.ready().await.unwrap();
            let node = node.as_ref().unwrap();
            node.task.abort();
            node.handle.clone()
        };
        tokio::task::yield_now().await;
        let replacement = client.ready().await.unwrap();
        assert!(!replacement.as_ref().unwrap().task.is_finished());
        assert!(old.bootstrapped().await.is_err());
        drop(replacement);
        client.shutdown().await;
        assert!(client.node.lock().await.is_none());
    }
}
