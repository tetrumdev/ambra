use crate::{Identity, PublicKey, Result, transport};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6},
    time::Duration,
};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio_util::sync::CancellationToken;
use peeroxide_dht::address_policy::{is_native_interface, is_overlay};

pub const DISCOVERY_PORT: u16 = 38148;
pub const DISCOVERY_REQUEST: &[u8] = b"AMBRA-DISCOVER/1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Advertisement {
    pub service: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub port: u16,
    #[serde(default)]
    pub public_key: Option<PublicKey>,
    #[serde(default)]
    pub secure_port: Option<u16>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    #[serde(flatten)]
    pub info: Advertisement,
    pub address: SocketAddr,
}

pub fn is_local(ip: IpAddr) -> bool {
    if is_overlay(ip) { return false; }
    match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(ip) => {
            ip.to_ipv4_mapped()
                .is_some_and(|ip| is_local(IpAddr::V4(ip)))
                || ip.is_loopback()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || if_addrs::get_if_addrs()
                    .unwrap_or_default()
                    .iter()
                    .filter(|i| is_native_interface(&i.name, i.ip()))
                    .any(|i| match &i.addr {
                        if_addrs::IfAddr::V6(local) => {
                            u128::from(ip) & u128::from(local.netmask)
                                == u128::from(local.ip) & u128::from(local.netmask)
                        }
                        _ => false,
                    })
        }
    }
}

pub fn broadcast_targets() -> Vec<SocketAddr> {
    let mut targets = vec![SocketAddr::from((Ipv4Addr::BROADCAST, DISCOVERY_PORT))];
    for interface in if_addrs::get_if_addrs().unwrap_or_default() {
        if !is_native_interface(&interface.name, interface.ip()) { continue; }
        if let if_addrs::IfAddr::V4(ref addr) = interface.addr {
            if interface.is_loopback() {
                continue;
            }
            let target = SocketAddr::from((
                addr.broadcast.unwrap_or(Ipv4Addr::BROADCAST),
                DISCOVERY_PORT,
            ));
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
    }
    targets
}

const MULTICAST_V6: Ipv6Addr = Ipv6Addr::new(0xff12, 0, 0, 0, 0, 0, 0, 0xa6b2);
fn ipv6_socket(port: u16, join: bool) -> Result<UdpSocket> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV6,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )?;
    socket.set_only_v6(true)?;
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddr::from((Ipv6Addr::UNSPECIFIED, port)).into())?;
    if join {
        for interface in if_addrs::get_if_addrs().unwrap_or_default() {
            if !is_native_interface(&interface.name, interface.ip()) { continue; }
            if let Some(index) = interface.index {
                let _ = socket.join_multicast_v6(&MULTICAST_V6, index);
            }
        }
    }
    Ok(UdpSocket::from_std(socket.into())?)
}
fn ipv6_targets() -> Vec<SocketAddr> {
    let mut targets = Vec::new();
    for interface in if_addrs::get_if_addrs().unwrap_or_default() {
        if !is_native_interface(&interface.name, interface.ip()) { continue; }
        if interface.is_loopback() {
            continue;
        }
        if let Some(index) = interface.index {
            let address = SocketAddr::V6(SocketAddrV6::new(MULTICAST_V6, DISCOVERY_PORT, 0, index));
            if !targets.contains(&address) {
                targets.push(address);
            }
        }
    }
    targets
}
async fn discover_socket(
    socket: UdpSocket,
    targets: Vec<SocketAddr>,
    duration: Duration,
) -> Result<Vec<DiscoveredServer>> {
    for target in targets {
        let _ = socket.send_to(DISCOVERY_REQUEST, target).await;
    }
    let mut found = Vec::new();
    let deadline = tokio::time::Instant::now() + duration;
    let mut buffer = [0; 2048];
    while let Ok(Ok((length, sender))) =
        tokio::time::timeout_at(deadline, socket.recv_from(&mut buffer)).await
    {
        if !is_local(sender.ip()) {
            continue;
        }
        let Ok(info) = serde_json::from_slice::<Advertisement>(&buffer[..length]) else {
            continue;
        };
        if info.service != "ambra" || info.id.len() > 64 || info.name.len() > 256 || info.port == 0
        {
            continue;
        }
        // Preserve IPv6 interface scope from the received address.
        let mut address = sender;
        address.set_port(info.secure_port.unwrap_or(info.port));
        if !found.iter().any(|s: &DiscoveredServer| {
            s.address == address && s.info.public_key == info.public_key
        }) {
            found.push(DiscoveredServer { info, address });
        }
        if found.len() >= 64 {
            break;
        }
    }
    Ok(found)
}
pub async fn discover(duration: Duration) -> Result<Vec<DiscoveredServer>> {
    let v4 = async {
        let socket = UdpSocket::bind("0.0.0.0:0").await?;
        socket.set_broadcast(true)?;
        discover_socket(socket, broadcast_targets(), duration).await
    };
    let v6 = async { discover_socket(ipv6_socket(0, false)?, ipv6_targets(), duration).await };
    let (v4, v6): (Result<Vec<DiscoveredServer>>, Result<Vec<DiscoveredServer>>) =
        tokio::join!(v4, v6);
    if v4.is_err() && v6.is_err() {
        return Err("No LAN discovery socket is available".into());
    }
    let mut found = v4.unwrap_or_default();
    found.extend(v6.unwrap_or_default());
    Ok(found)
}

/// One discovery protocol, on IPv4 broadcasts and link-scoped IPv6 multicast.
pub async fn serve_discovery(
    advertisement: std::sync::Arc<dyn Fn() -> Option<Advertisement> + Send + Sync>,
    cancel: CancellationToken,
) -> Result<()> {
    let mut sockets = Vec::new();
    if let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT)).await {
        sockets.push(socket);
    }
    if let Ok(socket) = ipv6_socket(DISCOVERY_PORT, true) {
        sockets.push(socket);
    }
    if sockets.is_empty() {
        return Err("Could not bind LAN discovery port".into());
    }
    let mut tasks = tokio::task::JoinSet::new();
    for socket in sockets {
        let advertisement = advertisement.clone();
        let cancel = cancel.clone();
        tasks.spawn(async move {
            let mut buffer = [0; 64]; let mut budget = 64; let mut window = tokio::time::Instant::now();
            loop {
                let result = tokio::select! { _ = cancel.cancelled() => break, result = socket.recv_from(&mut buffer) => result };
                let (length, sender) = result?;
                if window.elapsed() >= Duration::from_secs(1) { window = tokio::time::Instant::now(); budget = 64; }
                if budget == 0 || !is_local(sender.ip()) || &buffer[..length] != DISCOVERY_REQUEST { continue; }
                budget -= 1;
                if let Some(info) = advertisement() { let _ = socket.send_to(&serde_json::to_vec(&info)?, sender).await; }
            }
            Ok::<_, crate::Error>(())
        });
    }
    while let Some(result) = tasks.join_next().await {
        result??;
    }
    Ok(())
}

/// Prefer a single dual-stack listener where the configured bind shares all interfaces.
pub async fn bind(address: SocketAddr) -> Result<TcpListener> {
    if address.ip().is_unspecified() {
        let dual = (|| -> std::io::Result<TcpListener> {
            let socket = socket2::Socket::new(
                socket2::Domain::IPV6,
                socket2::Type::STREAM,
                Some(socket2::Protocol::TCP),
            )?;
            socket.set_only_v6(false)?;
            socket.set_reuse_address(true)?;
            socket.set_nonblocking(true)?;
            socket.bind(&SocketAddr::from((Ipv6Addr::UNSPECIFIED, address.port())).into())?;
            socket.listen(128)?;
            TcpListener::from_std(socket.into())
        })();
        if let Ok(listener) = dual {
            return Ok(listener);
        }
    }
    Ok(TcpListener::bind(address).await?)
}

pub fn local_addresses(port: u16) -> Vec<SocketAddr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .iter()
        .filter(|i| !i.is_loopback())
        .filter(|i| is_native_interface(&i.name, i.ip()))
        .filter(|i| is_local(i.ip()))
        .map(|i| SocketAddr::new(i.ip(), port))
        .take(16)
        .collect()
}

pub async fn connect(
    address: SocketAddr,
    key: PublicKey,
    identity: &Identity,
) -> Result<(tokio::io::DuplexStream, transport::Pump)> {
    if !is_local(address.ip()) {
        return Err("LAN connections require a local address".into());
    }
    let raw = TcpStream::connect(address).await?;
    raw.set_nodelay(true)?;
    let (io, _, pump) = transport::secure(raw, identity, Some(key)).await?;
    Ok((io, pump))
}

pub async fn serve(
    listener: TcpListener,
    identity: Identity,
    app: axum::Router,
    cancel: CancellationToken,
) -> Result<()> {
    let limit = std::sync::Arc::new(tokio::sync::Semaphore::new(64));
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            accepted = listener.accept() => {
                let (raw, address) = accepted?;
                // A globally reachable TCP socket must not become a fourth remote method.
                if !is_local(address.ip()) { continue; }
                let Ok(permit) = limit.clone().try_acquire_owned() else { continue; };
                let identity = identity.clone(); let app = app.clone(); let cancel = cancel.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    if let Ok(Ok((io, mut peer, pump))) = tokio::time::timeout(Duration::from_secs(5), transport::secure(raw, &identity, None)).await {
                        peer.address = address;
                        let _ = transport::serve(io, pump, peer, app, cancel).await;
                    }
                });
            }
        }
    }
    tasks.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn discovery_ignores_malformed_packets_and_retains_distinct_servers() {
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let target = server.local_addr().unwrap();
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let responder = tokio::spawn(async move {
            let mut buffer = [0; 64];
            let (_, peer) = server.recv_from(&mut buffer).await.unwrap();
            server.send_to(b"not JSON", peer).await.unwrap();
            server
                .send_to(
                    br#"{"service":"ambra","id":"bad","name":"bad","version":"1","port":0}"#,
                    peer,
                )
                .await
                .unwrap();
            for name in ["One", "Two"] {
                let info = Advertisement {
                    service: "ambra".into(),
                    id: name.into(),
                    name: name.into(),
                    version: "1".into(),
                    port: 38147,
                    public_key: Some(Identity::generate().unwrap().public_key()),
                    secure_port: Some(38149),
                };
                server
                    .send_to(&serde_json::to_vec(&info).unwrap(), peer)
                    .await
                    .unwrap();
            }
        });
        let found = discover_socket(client, vec![target], Duration::from_millis(100))
            .await
            .unwrap();
        responder.await.unwrap();
        assert_eq!(found.len(), 2);
        assert_ne!(found[0].info.public_key, found[1].info.public_key);
    }
}
