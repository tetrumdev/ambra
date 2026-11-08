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

/// A LAN or Tailscale address that means the same on every device: private or link-local
/// IPv4, IPv6 unique-local, or an overlay. A global IPv6 address is "local" only to devices on
/// its own prefix, so it never goes into a pairing link other devices must accept.
pub fn is_portable_direct(ip: IpAddr) -> bool {
    is_overlay(ip) || ip.is_loopback() || match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
        IpAddr::V6(ip) => ip.is_unique_local() || ip.to_ipv4_mapped().is_some_and(|ip| ip.is_private()),
    }
}

/// An already routed LAN or Tailscale address can use the pinned TCP transport.
/// Overlay addresses remain excluded from native discovery and public NAT traversal.
pub fn is_direct(ip: IpAddr) -> bool {
    is_local(ip) || is_overlay(ip)
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

/// Pairing links include installed overlay addresses as well as native LAN hints.
pub fn direct_addresses(port: u16) -> Vec<SocketAddr> {
    let mut overlays = Vec::new();
    for interface in if_addrs::get_if_addrs().unwrap_or_default() {
        let address = SocketAddr::new(interface.ip(), port);
        if is_overlay(interface.ip()) && !overlays.contains(&address) {
            overlays.push(address);
        }
    }
    overlays.truncate(16);
    let mut addresses = local_addresses(port);
    addresses.truncate(16 - overlays.len());
    addresses.extend(overlays);
    addresses
}

pub async fn connect(
    address: SocketAddr,
    key: PublicKey,
    identity: &Identity,
) -> Result<(tokio::io::DuplexStream, transport::Pump)> {
    if !is_direct(address.ip()) {
        return Err("Direct connections require a LAN or Tailscale address".into());
    }
    connect_tcp(address, key, identity).await
}

/// Dials the server's router-forwarded public TCP port. A signed knock proves this device
/// is paired before the server answers at all; the pinned Noise handshake then
/// authenticates the server, so the path itself need not be trusted.
pub async fn connect_public(
    address: SocketAddr,
    key: PublicKey,
    identity: &Identity,
) -> Result<(tokio::io::DuplexStream, transport::Pump)> {
    if is_direct(address.ip()) || address.port() == 0 || address.ip().is_unspecified() {
        return Err("Not a public endpoint".into());
    }
    let mut raw = TcpStream::connect(address).await?;
    raw.set_nodelay(true)?;
    // Sent back to back with the first Noise message: no extra round trip.
    tokio::io::AsyncWriteExt::write_all(&mut raw, &crate::gate::knock(identity, key)).await?;
    let (io, _, pump) = transport::secure(raw, identity, Some(key)).await?;
    Ok((io, pump))
}

async fn connect_tcp(
    address: SocketAddr,
    key: PublicKey,
    identity: &Identity,
) -> Result<(tokio::io::DuplexStream, transport::Pump)> {
    let raw = TcpStream::connect(address).await?;
    raw.set_nodelay(true)?;
    let (io, _, pump) = transport::secure(raw, identity, Some(key)).await?;
    Ok((io, pump))
}

type PerAddressMap = std::sync::Arc<std::sync::Mutex<std::collections::HashMap<IpAddr, usize>>>;
/// Counts open connections from one public address; released on drop.
struct PerAddress(PerAddressMap, IpAddr);
impl PerAddress {
    const LIMIT: usize = 8;
    fn acquire(map: &PerAddressMap, ip: IpAddr) -> Option<Self> {
        let mut counts = map.lock().ok()?;
        let count = counts.entry(ip).or_default();
        if *count >= Self::LIMIT { return None; }
        *count += 1;
        Some(Self(map.clone(), ip))
    }
}
impl Drop for PerAddress {
    fn drop(&mut self) {
        if let Ok(mut counts) = self.0.lock() {
            if let Some(count) = counts.get_mut(&self.1) {
                *count -= 1;
                if *count == 0 { counts.remove(&self.1); }
            }
        }
    }
}

/// Serves LAN and Tailscale peers directly. Internet peers (a router-forwarded port) must
/// first present a signed knock from a key `admit_public` accepts; everyone else is
/// disconnected without receiving a byte.
pub async fn serve(
    listener: TcpListener,
    identity: Identity,
    app: axum::Router,
    admit_public: crate::gate::Admit,
    cancel: CancellationToken,
) -> Result<()> {
    let replay = std::sync::Arc::new(crate::gate::Replay::default());
    let limit = std::sync::Arc::new(tokio::sync::Semaphore::new(64));
    let per_address: PerAddressMap = Default::default();
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            accepted = listener.accept() => {
                let (mut raw, address) = accepted?;
                // Internet peers arrive through a router-forwarded port. One address may
                // not hold more than a few of the shared connection slots.
                let public = !is_direct(address.ip());
                let Some(per_address) = (!public).then_some(None).or_else(|| PerAddress::acquire(&per_address, address.ip()).map(Some)) else { continue; };
                let Ok(permit) = limit.clone().try_acquire_owned() else { continue; };
                let _ = raw.set_nodelay(true);
                let identity = identity.clone(); let app = app.clone(); let cancel = cancel.clone();
                let admit = admit_public.clone(); let replay = replay.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    let _per_address = per_address;
                    // A LAN peer may still knock: a device at home dialing the public
                    // address through a router that loops it back arrives from a LAN address.
                    let knocking = public || {
                        let mut head = [0u8; 4];
                        let peeked = tokio::time::timeout(Duration::from_secs(5), async {
                            loop {
                                match raw.peek(&mut head).await { Ok(n) if n >= 4 => break true, Ok(0) | Err(_) => break false, Ok(_) => tokio::time::sleep(Duration::from_millis(5)).await }
                            }
                        }).await;
                        if !matches!(peeked, Ok(true)) { return; }
                        head == crate::gate::MARKER
                    };
                    let knocked = if knocking {
                        let mut knock = [0u8; crate::gate::KNOCK_LEN];
                        let read = tokio::time::timeout(Duration::from_secs(3), tokio::io::AsyncReadExt::read_exact(&mut raw, &mut knock)).await;
                        if !matches!(read, Ok(Ok(_))) { return; }
                        match crate::gate::check_knock(&knock, identity.public_key(), &admit, &replay) {
                            Some(key) => Some(key),
                            None => return,
                        }
                    } else { None };
                    if let Ok(Ok((io, mut peer, pump))) = tokio::time::timeout(Duration::from_secs(5), transport::secure(raw, &identity, None)).await {
                        // The Noise identity must be the key that knocked.
                        if knocked.is_some_and(|key| key != peer.public_key) { return; }
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
    #[test]
    fn direct_policy_allows_routed_overlays_without_treating_them_as_native_lan() {
        for address in ["100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1", "::ffff:100.88.191.47"] {
            let ip = address.parse().unwrap();
            assert!(is_direct(ip), "{address}");
            assert!(!is_local(ip), "{address}");
        }
        for address in ["192.168.1.20", "127.0.0.1", "::1", "fd12::1"] {
            assert!(is_direct(address.parse().unwrap()), "{address}");
        }
        for address in ["8.8.8.8", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111"] {
            assert!(!is_direct(address.parse().unwrap()), "{address}");
        }
        let advertised = direct_addresses(38149);
        assert!(advertised.len() <= 16);
        assert!(advertised.iter().all(|a| is_direct(a.ip()) && a.port() == 38149));
        assert!(local_addresses(38149).iter().all(|a| !is_overlay(a.ip())));
    }

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

    #[tokio::test]
    async fn knock_admits_paired_devices_and_strangers_get_no_bytes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let server = Identity::generate().unwrap();
        let device = Identity::generate().unwrap();
        let stranger = Identity::generate().unwrap();
        let paired = device.public_key();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let app = axum::Router::new().route("/ok", axum::routing::get(|| async { "ok" }));
        let admit: crate::gate::Admit = std::sync::Arc::new(move |key| *key == paired);
        let task = tokio::spawn(serve(listener, server.clone(), app, admit, cancel.clone()));

        // A paired device's knock is accepted, even arriving from a LAN address.
        let mut raw = TcpStream::connect(address).await.unwrap();
        raw.write_all(&crate::gate::knock(&device, server.public_key())).await.unwrap();
        let (io, _, pump) = transport::secure(raw, &device, Some(server.public_key())).await.unwrap();
        let connection = transport::HttpConnection::new(io, pump).await.unwrap();
        let response = connection.request(hyper::Request::get("/ok").body(axum::body::Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), 200);
        connection.close();

        // An unpaired key: the server closes without sending one byte.
        let mut raw = TcpStream::connect(address).await.unwrap();
        raw.write_all(&crate::gate::knock(&stranger, server.public_key())).await.unwrap();
        let mut buffer = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(5), raw.read_to_end(&mut buffer)).await.unwrap();
        assert!(read.is_err() || buffer.is_empty(), "stranger received {} bytes", buffer.len());

        // Knocking with a paired key but completing Noise as someone else is refused.
        let mut raw = TcpStream::connect(address).await.unwrap();
        raw.write_all(&crate::gate::knock(&device, server.public_key())).await.unwrap();
        let swapped = transport::secure(raw, &stranger, Some(server.public_key())).await;
        if let Ok((io, _, pump)) = swapped {
            let connection = transport::HttpConnection::new(io, pump).await;
            if let Ok(connection) = connection {
                let response = connection.request(hyper::Request::get("/ok").body(axum::body::Body::empty()).unwrap()).await;
                assert!(response.is_err(), "swapped identity reached HTTP");
            }
        }

        // LAN peers without a knock still connect directly.
        let (io, pump) = connect(address, server.public_key(), &stranger).await.unwrap();
        let connection = transport::HttpConnection::new(io, pump).await.unwrap();
        let response = connection.request(hyper::Request::get("/ok").body(axum::body::Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), 200);
        connection.close();

        cancel.cancel();
        task.await.unwrap().unwrap();
    }
}
