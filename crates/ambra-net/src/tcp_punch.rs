//! Direct TCP simultaneous-open primitives. No router mapping, UDP, proxy or relay fallback.
//! A held TCP STUN connection, listener and active sockets share one explicit local port.
mod session;
pub use session::{SharedStatus, Status, connect, connect_with, serve};

use crate::{Identity, PublicKey, Result, transport};
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    future::Future,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateType {
    Host,
    ServerReflexive,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub address: SocketAddr,
    pub kind: CandidateType,
    /// RFC 6544 simultaneous-open, rather than pretending a passive listener traverses NAT.
    pub tcp_type: TcpType,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TcpType {
    SimultaneousOpen,
}
impl Candidate {
    pub fn validate(&self) -> Result<()> {
        let SocketAddr::V4(address) = self.address else {
            return Err("TCP punching currently requires IPv4".into());
        };
        let [a, b, ..] = address.ip().octets();
        if address.port() == 0
            || !crate::portmap::is_public(*address.ip())
            || a == 0
            || (a == 198 && (b == 18 || b == 19))
            || (a == 192 && b == 0)
        {
            return Err("TCP candidate must be a native public unicast address".into());
        }
        Ok(())
    }
}

#[cfg(unix)]
fn inherited_socket(fd: std::os::fd::RawFd) -> Result<Socket> {
    use std::os::fd::FromRawFd;
    // Duplicate atomically, validating even a closed descriptor before constructing an
    // owned Rust descriptor. This matches the existing pwnat launcher's handoff pattern.
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if duplicate < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let socket = unsafe { Socket::from_raw_fd(duplicate) };
    let local = socket
        .local_addr()?
        .as_socket()
        .ok_or("Invalid inherited socket address")?;
    if socket.r#type()? != Type::STREAM
        || socket.peer_addr().is_ok()
        || !local.is_ipv4()
        || local.port() != 443
        || local.ip().is_unspecified()
    {
        return Err("Inherited socket must be an unconnected IPv4 TCP/443 binding".into());
    }
    Ok(socket)
}

#[derive(Clone, Default)]
pub struct Config {
    pub port: u16,
    pool: Arc<Mutex<Vec<Socket>>>,
}
impl Config {
    /// Optional launcher prebinds TCP/443 and drops root before exec. Descriptors are
    /// consumed exactly once, never recreated with process-wide elevated privileges.
    pub fn from_env() -> Result<Self> {
        let port = std::env::var("AMBRA_TCP_PUNCH_PORT")
            .ok()
            .map(|v| v.parse())
            .transpose()?
            .unwrap_or(0);
        let config = Self {
            port,
            ..Self::default()
        };
        #[cfg(unix)]
        if let Ok(value) = std::env::var("AMBRA_TCP_PUNCH_FDS") {
            use std::os::fd::FromRawFd;
            let fds: Vec<i32> = value
                .split(',')
                .map(str::parse)
                .collect::<std::result::Result<_, _>>()?;
            let unique: std::collections::HashSet<_> = fds.iter().copied().collect();
            if fds.is_empty()
                || fds.len() > 128
                || unique.len() != fds.len()
                || fds.iter().any(|fd| *fd < 3)
                || port != 443
            {
                return Err("Invalid inherited TCP/443 socket pool".into());
            }
            for fd in fds {
                let socket = inherited_socket(fd)?;
                // The duplicate has CLOEXEC. Close the original inherited descriptor now.
                drop(unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) });
                config
                    .pool
                    .lock()
                    .map_err(|_| "TCP socket pool poisoned")?
                    .push(socket);
            }
        }
        Ok(config)
    }
    fn socket(
        &self,
        address: SocketAddr,
        interface: Option<&if_addrs::Interface>,
    ) -> Result<Socket> {
        #[cfg(windows)]
        return Err("TCP simultaneous-open socket reuse is not yet qualified on Windows".into());
        #[cfg(not(windows))]
        {
            let socket = if address.port() == 443
                && !self
                    .pool
                    .lock()
                    .map_err(|_| "TCP pool unavailable")?
                    .is_empty()
            {
                let socket = self
                    .pool
                    .lock()
                    .map_err(|_| "TCP pool unavailable")?
                    .pop()
                    .ok_or("TCP socket pool exhausted")?;
                if socket.local_addr()?.as_socket() != Some(address) {
                    return Err("Inherited TCP binding does not match native interface".into());
                }
                socket
            } else {
                let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
                socket.set_reuse_address(true)?;
                #[cfg(unix)]
                socket.set_reuse_port(true)?;
                socket.bind(&address.into()).map_err(|e| {
                    format!(
                        "TCP bind {address}: {e}; TCP/443 may need the optional socket launcher"
                    )
                })?;
                socket
            };
            // A physical interface binding prevents an installed VPN from carrying this path.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let Some(interface) = interface {
                socket
                    .bind_device_by_index_v4(interface.index.and_then(std::num::NonZeroU32::new))?;
            }
            #[cfg(any(target_os = "linux", target_os = "android"))]
            if let Some(interface) = interface {
                socket.bind_device(Some(interface.name.as_bytes()))?;
            }
            socket.set_nonblocking(true)?;
            Ok(socket)
        }
    }
}

pub struct Endpoint {
    pub candidates: Vec<Candidate>,
    local: SocketAddr,
    interface: Option<if_addrs::Interface>,
    listener: TcpListener,
    // Keeps the observed NAT mapping alive until punching finishes. Never used for peer data.
    _stun: Option<TcpStream>,
    config: Config,
}
impl Endpoint {
    pub async fn gather(config: Config) -> Result<Self> {
        let interfaces = tokio::task::spawn_blocking(if_addrs::get_if_addrs).await??;
        let mut errors = Vec::new();
        for interface in interfaces
            .into_iter()
            .filter(|i| {
                !i.is_loopback()
                    && i.ip().is_ipv4()
                    && peeroxide_dht::address_policy::is_native_interface(&i.name, i.ip())
            })
            .take(4)
        {
            let result = tokio::time::timeout(
                Duration::from_secs(7),
                Self::gather_on(config.clone(), interface),
            )
            .await;
            match result {
                Ok(Ok(endpoint)) => return Ok(endpoint),
                Ok(Err(error)) => errors.push(error.to_string()),
                Err(_) => errors.push("TCP STUN timed out".into()),
            }
        }
        Err(format!("No reusable native TCP candidate: {}", errors.join("; ")).into())
    }
    async fn gather_on(config: Config, interface: if_addrs::Interface) -> Result<Self> {
        let socket = config.socket(
            SocketAddr::new(interface.ip(), config.port),
            Some(&interface),
        )?;
        let local = socket
            .local_addr()?
            .as_socket()
            .ok_or("No local TCP address")?;
        let addresses = tokio::net::lookup_host(("stun.nextcloud.com", 443)).await?;
        let remote = addresses
            .into_iter()
            .find(|a| a.is_ipv4())
            .ok_or("No IPv4 TCP STUN address")?;
        let mut control = TcpSocket::from_std_stream(socket.into())
            .connect(remote)
            .await?;
        let mut transaction = [0; 12];
        getrandom::fill(&mut transaction).map_err(|e| std::io::Error::other(e.to_string()))?;
        let mut request = [0u8; 20];
        request[..2].copy_from_slice(&1u16.to_be_bytes());
        request[4..8].copy_from_slice(&0x2112a442u32.to_be_bytes());
        request[8..].copy_from_slice(&transaction);
        control.write_all(&request).await?;
        let mut header = [0; 20];
        control.read_exact(&mut header).await?;
        let length = u16::from_be_bytes(header[2..4].try_into()?) as usize;
        if length > 1024 || length % 4 != 0 {
            return Err("Invalid TCP STUN frame size".into());
        }
        let mut packet = vec![0; 20 + length];
        packet[..20].copy_from_slice(&header);
        control.read_exact(&mut packet[20..]).await?;
        let address = parse_stun(&packet, &transaction)?;
        let candidate = Candidate {
            address,
            kind: CandidateType::ServerReflexive,
            tcp_type: TcpType::SimultaneousOpen,
        };
        candidate.validate()?;
        let socket = config.socket(local, Some(&interface))?;
        socket.listen(8)?;
        let listener = TcpListener::from_std(socket.into())?;
        tracing::info!(%local, candidate = %address, interface = %interface.name, stun_peer = %remote, "Native TCP candidate gathered; mapping reuse is not guaranteed across destinations");
        let mut candidates = vec![candidate];
        if matches!(local.ip(), std::net::IpAddr::V4(ip) if crate::portmap::is_public(ip))
            && local != address
        {
            candidates.push(Candidate {
                address: local,
                kind: CandidateType::Host,
                tcp_type: TcpType::SimultaneousOpen,
            });
        }
        Ok(Self {
            candidates,
            local,
            interface: Some(interface),
            listener,
            _stun: Some(control),
            config,
        })
    }
    /// Race incoming and repeated outgoing sockets through peer authentication. A SYN proxy's
    /// immediate connect() success never wins this race without the real peer's Noise proof.
    pub async fn punch<T, F, Fut>(
        &self,
        candidates: &[Candidate],
        cancel: &CancellationToken,
        authenticate: F,
    ) -> Result<T>
    where
        T: Send + 'static,
        F: Fn(TcpStream) -> Fut,
        Fut: Future<Output = Result<T>> + Send + 'static,
    {
        if candidates.is_empty() || candidates.len() > 4 {
            return Err("Invalid peer candidate count".into());
        }
        for c in candidates {
            c.validate()?;
        }
        self.punch_addresses(
            &candidates.iter().map(|c| c.address).collect::<Vec<_>>(),
            cancel,
            authenticate,
        )
        .await
    }
    async fn punch_addresses<T, F, Fut>(
        &self,
        candidates: &[SocketAddr],
        cancel: &CancellationToken,
        authenticate: F,
    ) -> Result<T>
    where
        T: Send + 'static,
        F: Fn(TcpStream) -> Fut,
        Fut: Future<Output = Result<T>> + Send + 'static,
    {
        let mut tasks: JoinSet<Result<T>> = JoinSet::new();
        let mut connecting: JoinSet<
            std::result::Result<std::io::Result<TcpStream>, tokio::time::error::Elapsed>,
        > = JoinSet::new();
        let deadline = tokio::time::sleep(Duration::from_secs(24));
        tokio::pin!(deadline);
        let mut tick = tokio::time::interval(Duration::from_secs(4));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut dials = 0;
        let mut accepted = 0;
        let mut last_error = "No peer socket answered".to_owned();
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("TCP punching cancelled".into()),
                _ = &mut deadline => return Err(format!("Direct TCP punching failed: {last_error}").into()),
                Some(joined) = tasks.join_next(), if !tasks.is_empty() => match joined {
                    Ok(Ok(value)) => return Ok(value),
                    Ok(Err(error)) if transport::authentication_failed(&error) => return Err(error),
                    Ok(Err(error)) => { last_error = error.to_string(); tracing::debug!(%last_error, "TCP candidate authentication failed"); }
                    Err(_) => {}
                },
                Some(result) = connecting.join_next(), if !connecting.is_empty() => {
                    if let Ok(Ok(Ok(raw))) = result {
                        let _ = raw.set_nodelay(true);
                        tracing::info!(local = %raw.local_addr()?, peer = %raw.peer_addr()?, "TCP punch active socket; authenticating peer");
                        let auth = authenticate(raw);
                        tasks.spawn(async move { tokio::time::timeout(Duration::from_secs(8), auth).await? });
                    }
                }
                result = self.listener.accept(), if accepted < 16 && tasks.len() + connecting.len() < 8 => {
                    let (raw, address) = result?;
                    if !candidates.iter().any(|c| c.ip() == address.ip()) { continue; }
                    accepted += 1;
                    let _ = raw.set_nodelay(true);
                    tracing::info!(local = %self.local, peer = %address, "TCP punch accepted; not yet authenticated");
                    let auth = authenticate(raw);
                    tasks.spawn(async move { tokio::time::timeout(Duration::from_secs(8), auth).await? });
                }
                _ = tick.tick(), if dials < 6 && tasks.len() + connecting.len() < 8 => {
                    let address = candidates[dials % candidates.len()];
                    dials += 1;
                    let socket = self.config.socket(self.local, self.interface.as_ref())?;
                    let connect = TcpSocket::from_std_stream(socket.into()).connect(address);
                    connecting.spawn(async move { tokio::time::timeout(Duration::from_secs(7), connect).await });
                }
            }
        }
    }
}

fn parse_stun(packet: &[u8], transaction: &[u8; 12]) -> Result<SocketAddr> {
    if packet.len() < 20
        || packet[..2] != [1, 1]
        || packet[4..8] != [0x21, 0x12, 0xa4, 0x42]
        || &packet[8..20] != transaction
        || u16::from_be_bytes(packet[2..4].try_into()?) as usize + 20 != packet.len()
    {
        return Err("Invalid TCP STUN response".into());
    }
    let mut offset = 20;
    let mut mapped = None;
    while offset + 4 <= packet.len() {
        let kind = u16::from_be_bytes(packet[offset..offset + 2].try_into()?);
        let length = u16::from_be_bytes(packet[offset + 2..offset + 4].try_into()?) as usize;
        offset += 4;
        let value = packet
            .get(offset..offset + length)
            .ok_or("Truncated TCP STUN attribute")?;
        if (kind == 0x20 || kind == 1) && length == 8 && value[1] == 1 {
            let mut port = u16::from_be_bytes(value[2..4].try_into()?);
            let mut ip: [u8; 4] = value[4..8].try_into()?;
            if kind == 0x20 {
                port ^= 0x2112;
                for (b, mask) in ip.iter_mut().zip([0x21, 0x12, 0xa4, 0x42]) {
                    *b ^= mask;
                }
            }
            mapped = Some(SocketAddr::from((Ipv4Addr::from(ip), port)));
            if kind == 0x20 {
                return Ok(mapped.unwrap());
            }
        }
        offset += (length + 3) & !3;
        if offset > packet.len() {
            return Err("Invalid TCP STUN padding".into());
        }
    }
    mapped.ok_or_else(|| "TCP STUN returned no IPv4 mapping".into())
}

const NOMINATE: &[u8] = b"ambra/tcp-punch/v1\0";
/// Noise role is the application role, independent of which side accepted the TCP socket.
/// Only the client's nominated, authenticated socket survives when both active opens work.
pub async fn secure_client(
    mut raw: TcpStream,
    identity: Identity,
    server: PublicKey,
) -> Result<(tokio::io::DuplexStream, transport::Pump)> {
    let started = std::time::Instant::now();
    raw.write_all(&crate::gate::knock(&identity, server))
        .await?;
    let (io, _, pump) = transport::secure(raw, &identity, Some(server)).await?;
    tracing::info!(
        noise_ms = started.elapsed().as_secs_f64() * 1000.,
        "TCP punch Noise handshake complete"
    );
    Ok((io, pump))
}
pub async fn nominate(io: &mut tokio::io::DuplexStream) -> Result<()> {
    io.write_all(NOMINATE).await?;
    let mut ack = [0; 1];
    io.read_exact(&mut ack).await?;
    if ack != [1] {
        return Err("TCP nomination rejected".into());
    }
    Ok(())
}
pub async fn secure_server(
    mut raw: TcpStream,
    identity: Identity,
    expected: PublicKey,
    admit: crate::gate::Admit,
    replay: Arc<crate::gate::Replay>,
) -> Result<(
    tokio::io::DuplexStream,
    transport::RemotePeer,
    transport::Pump,
)> {
    let address = raw.peer_addr()?;
    let mut knock = [0; crate::gate::KNOCK_LEN];
    raw.read_exact(&mut knock).await?;
    if crate::gate::check_knock(&knock, identity.public_key(), &admit, &replay) != Some(expected) {
        return Err("TCP punch admission rejected".into());
    }
    let (mut io, mut peer, pump) = transport::secure(raw, &identity, None).await?;
    if peer.public_key != expected || !admit(&expected) {
        return Err("TCP punch Noise identity rejected".into());
    }
    let mut nomination = vec![0; NOMINATE.len()];
    io.read_exact(&mut nomination).await?;
    if nomination != NOMINATE {
        return Err("TCP punch nomination rejected".into());
    }
    io.write_all(&[1]).await?;
    peer.address = address;
    Ok((io, peer, pump))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn local() -> Endpoint {
        let config = Config::default();
        let socket = config.socket("127.0.0.1:0".parse().unwrap(), None).unwrap();
        let local = socket.local_addr().unwrap().as_socket().unwrap();
        socket.listen(8).unwrap();
        Endpoint {
            candidates: Vec::new(),
            local,
            listener: TcpListener::from_std(socket.into()).unwrap(),
            _stun: None,
            interface: None,
            config,
        }
    }
    #[cfg(unix)]
    #[test]
    fn inherited_pool_rejects_invalid_files_and_udp_without_consuming_originals() {
        use std::os::fd::AsRawFd;
        assert!(inherited_socket(i32::MAX).is_err());
        let file = tempfile::tempfile().unwrap();
        assert!(inherited_socket(file.as_raw_fd()).is_err());
        assert!(file.metadata().is_ok());
        let udp = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).unwrap();
        udp.bind(&"127.0.0.1:0".parse::<SocketAddr>().unwrap().into())
            .unwrap();
        assert!(inherited_socket(udp.as_raw_fd()).is_err());
        assert!(udp.local_addr().is_ok());
    }
    #[test]
    fn candidates_reject_internal_overlay_reserved_and_zero_ports() {
        for addr in [
            "127.0.0.1:443",
            "10.0.0.1:443",
            "192.168.1.1:80",
            "100.95.127.9:443",
            "0.1.2.3:443",
            "198.18.0.1:443",
            "192.0.2.1:443",
            "224.1.1.1:443",
            "8.8.8.8:0",
            "[::ffff:8.8.8.8]:443",
        ] {
            let c = Candidate {
                address: addr.parse().unwrap(),
                kind: CandidateType::ServerReflexive,
                tcp_type: TcpType::SimultaneousOpen,
            };
            assert!(c.validate().is_err(), "{addr}");
        }
        let candidate = Candidate {
            address: "8.8.8.8:443".parse().unwrap(),
            kind: CandidateType::Host,
            tcp_type: TcpType::SimultaneousOpen,
        };
        assert!(candidate.validate().is_ok());
        assert_eq!(
            serde_json::from_str::<Candidate>(&serde_json::to_string(&candidate).unwrap()).unwrap(),
            candidate
        );
    }
    #[test]
    fn stun_checks_transaction_framing_and_xor_mapping_without_panics() {
        let transaction = [9; 12];
        let mut packet = vec![1, 1, 0, 12, 0x21, 0x12, 0xa4, 0x42];
        packet.extend(transaction);
        packet.extend([
            0,
            0x20,
            0,
            8,
            0,
            1,
            0x21 ^ 1,
            0x12 ^ 0xbb,
            0x21 ^ 8,
            0x12 ^ 8,
            0xa4 ^ 8,
            0x42 ^ 8,
        ]);
        assert_eq!(
            parse_stun(&packet, &transaction).unwrap(),
            "8.8.8.8:443".parse().unwrap()
        );
        assert!(parse_stun(&packet, &[0; 12]).is_err());
        for len in 0..packet.len() {
            assert!(parse_stun(&packet[..len], &transaction).is_err());
        }
        packet[22..24].copy_from_slice(&1024u16.to_be_bytes());
        assert!(parse_stun(&packet, &transaction).is_err());
    }
    #[tokio::test]
    async fn simultaneous_open_reuses_source_port_and_carries_authorized_http2_and_ranges() {
        use axum::{Router, body::Body, response::IntoResponse, routing::get};
        use http_body_util::BodyExt;
        let client = local();
        let server = local();
        let server_address = server.local;
        let client_address = client.local;
        let server_identity = Identity::generate().unwrap();
        let server_key = server_identity.public_key();
        let client_identity = Identity::generate().unwrap();
        let client_key = client_identity.public_key();
        let admit: crate::gate::Admit = Arc::new(move |key| *key == client_key);
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let server_task = tokio::spawn(async move {
            let replay = Arc::new(crate::gate::Replay::default());
            let (io, peer, pump) = server
                .punch_addresses(&[client_address], &stop, |raw| {
                    assert_eq!(raw.local_addr().unwrap().port(), server_address.port());
                    secure_server(
                        raw,
                        server_identity.clone(),
                        client_key,
                        admit.clone(),
                        replay.clone(),
                    )
                })
                .await
                .unwrap();
            assert_eq!(peer.public_key, client_key);
            let app = Router::new().route(
                "/audio",
                get(move |request: axum::extract::Request| async move {
                    if request
                        .headers()
                        .get("authorization")
                        .is_none_or(|h| h != "Bearer paired-fixture")
                    {
                        return hyper::StatusCode::UNAUTHORIZED.into_response();
                    }
                    assert_eq!(
                        request
                            .extensions()
                            .get::<transport::RemotePeer>()
                            .unwrap()
                            .public_key,
                        client_key
                    );
                    if request.headers().contains_key("range") {
                        (
                            hyper::StatusCode::PARTIAL_CONTENT,
                            [("content-range", "bytes 100-199/2097152")],
                            Body::from(vec![42; 100]),
                        )
                            .into_response()
                    } else {
                        Body::from(vec![42; 2 * 1024 * 1024]).into_response()
                    }
                }),
            );
            transport::serve(io, pump, peer, app, stop).await.unwrap();
        });
        let (mut io, pump) = tokio::time::timeout(
            Duration::from_secs(12),
            client.punch_addresses(&[server_address], &cancel, |raw| {
                assert_eq!(raw.local_addr().unwrap().port(), client_address.port());
                secure_client(raw, client_identity.clone(), server_key)
            }),
        )
        .await
        .unwrap()
        .unwrap();
        nominate(&mut io).await.unwrap();
        let http = transport::HttpConnection::new(io, pump).await.unwrap();
        let request = |range: bool, token: &str| {
            let mut request = hyper::Request::builder()
                .uri("/audio")
                .header("authorization", token);
            if range {
                request = request.header("range", "bytes=100-199");
            }
            request.body(Body::empty()).unwrap()
        };
        assert_eq!(
            http.request(request(false, "Bearer wrong"))
                .await
                .unwrap()
                .status(),
            401
        );
        let (full, range) = tokio::join!(
            http.request(request(false, "Bearer paired-fixture")),
            http.request(request(true, "Bearer paired-fixture"))
        );
        let range = range.unwrap();
        assert_eq!(range.status(), 206);
        assert_eq!(
            range.into_body().collect().await.unwrap().to_bytes(),
            vec![42; 100]
        );
        let bytes = full
            .unwrap()
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(bytes.len(), 2 * 1024 * 1024);
        assert!(bytes.iter().all(|b| *b == 42));
        http.close();
        cancel.cancel();
        server_task.await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_and_false_tcp_success_never_return_authenticated_connection() {
        let endpoint = local();
        let other = local();
        let cancel = CancellationToken::new();
        let addresses = [other.local];
        let operation = endpoint.punch_addresses(&addresses, &cancel, |_raw| async {
            Err::<(), _>("Noise peer identity rejected".into())
        });
        tokio::pin!(operation);
        tokio::select! { result = &mut operation => panic!("Unexpected result: {result:?}"), _ = tokio::time::sleep(Duration::from_millis(30)) => {} }
        cancel.cancel();
        assert!(
            operation
                .await
                .unwrap_err()
                .to_string()
                .contains("cancelled")
        );
    }
    #[tokio::test]
    async fn unpaired_knock_gets_no_noise_bytes_even_on_an_expected_source_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = Identity::generate().unwrap();
        let server_key = server.public_key();
        let stranger = Identity::generate().unwrap();
        let claimed = stranger.public_key();
        let task = tokio::spawn(async move {
            let (raw, _) = listener.accept().await.unwrap();
            secure_server(
                raw,
                server,
                claimed,
                Arc::new(|_| false),
                Arc::new(crate::gate::Replay::default()),
            )
            .await
            .is_err()
        });
        let mut raw = TcpStream::connect(address).await.unwrap();
        raw.write_all(&crate::gate::knock(&stranger, server_key))
            .await
            .unwrap();
        let mut byte = [0];
        assert_eq!(raw.read(&mut byte).await.unwrap(), 0);
        assert!(task.await.unwrap());
    }
}
