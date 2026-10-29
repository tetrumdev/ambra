//! Independent implementation from Autonomous NAT Traversal (P2P'10) and RFC 792.
//! No upstream pwnat implementation was read, translated, linked, or executed.
//! This bounded variant supports IPv4 NATs that preserve agreed ICMP identifiers and UDP ports.
use crate::{Identity, PublicKey, Result, transport};
use socket2::Socket;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use socket2::{Domain, Protocol, Type};
use std::{
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::UdpSocket,
};
use tokio_util::sync::CancellationToken;

// Documentation address, not a bootstrap/STUN/rendezvous service.
pub const ECHO_TARGET: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 1);
const SEQUENCE: u16 = 0xA4B1;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const RECORD_TTL: u64 = 180;
const CLOCK_SKEW: u64 = 30;

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub listening: Option<SocketAddr>,
    pub configured_endpoint: Option<SocketAddr>,
    pub public_endpoint: Option<SocketAddr>,
    pub error: Option<String>,
    pub discovery_error: Option<String>,
    pub icmp_echo_sent: u64,
    pub icmp_errors: u64,
    pub icmp_quotations_accepted: u64,
    pub udp_punches_sent: u64,
}
pub type SharedStatus = Arc<std::sync::RwLock<Status>>;

/// A signed DHT value is a candidate, not proof that a NAT preserves this UDP port.
/// Only public IPv4 information is published; Noise still authenticates the peer.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndpointRecord {
    protocol: String,
    endpoint: SocketAddr,
    expires_at: u64,
}
pub fn unix_seconds() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}
impl EndpointRecord {
    pub fn encode(endpoint: SocketAddr, now: u64) -> Result<Vec<u8>> {
        validate_endpoint(endpoint)?;
        Ok(serde_json::to_vec(&Self {
            protocol: "ambra-pwnat/1".into(),
            endpoint,
            expires_at: now.saturating_add(RECORD_TTL),
        })?)
    }
    pub fn decode(bytes: &[u8], now: u64) -> Result<SocketAddr> {
        if bytes.len() > 512 {
            return Err("pwnat endpoint record exceeds 512 bytes".into());
        }
        let record: Self = serde_json::from_slice(bytes)?;
        if record.protocol != "ambra-pwnat/1"
            || record.expires_at <= now
            || record.expires_at > now.saturating_add(RECORD_TTL + CLOCK_SKEW)
        {
            return Err(
                "pwnat endpoint record expired or has an unsupported lifetime/protocol".into(),
            );
        }
        validate_endpoint(record.endpoint)?;
        Ok(record.endpoint)
    }
}

pub fn validate_endpoint(address: SocketAddr) -> Result<()> {
    let SocketAddr::V4(address) = address else {
        return Err("pwnat requires a public IPv4 endpoint".into());
    };
    let ip = *address.ip();
    let [a, b, c, _] = ip.octets();
    if address.port() == 0
        || ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_documentation()
        || a == 0
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b == 18 || b == 19))
    {
        return Err("pwnat requires a global unicast IPv4 address and a nonzero UDP port; private, reserved and VPN endpoints are rejected".into());
    }
    Ok(())
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub available: bool,
    pub reason: String,
}

pub fn platform_supported() -> bool {
    cfg!(any(target_os = "linux", target_os = "macos"))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn inherited_socket(fd: std::os::fd::RawFd) -> Result<Socket> {
    use std::os::fd::FromRawFd;
    // F_DUPFD_CLOEXEC validates the descriptor without taking ownership of the launcher copy.
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
    if duplicate < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let socket = unsafe { Socket::from_raw_fd(duplicate) };
    if socket.r#type()? != Type::RAW || !socket.local_addr()?.is_ipv4() {
        return Err("AMBRA_PWNAT_ICMP_FD must reference an IPv4 raw ICMP socket".into());
    }
    #[cfg(target_os = "linux")]
    if socket.protocol()? != Some(Protocol::ICMPV4) {
        return Err("AMBRA_PWNAT_ICMP_FD is not ICMP".into());
    }
    // The initial launcher handoff is the only exec boundary allowed to inherit it.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(socket)
}

fn open_icmp() -> Result<Socket> {
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Err(
            "pwnat disabled: unsupported platform (mobile sandboxes and Windows are not supported)"
                .into(),
        )
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        if let Some(fd) = std::env::var_os("AMBRA_PWNAT_ICMP_FD") {
            return inherited_socket(fd.to_str().ok_or("Invalid ICMP descriptor")?.parse()?);
        }
        let socket = Socket::new(Domain::IPV4, Type::RAW, Some(Protocol::ICMPV4))?;
        socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into())?;
        Ok(socket)
    }
}
fn raw_socket() -> Result<UdpSocket> {
    let socket = open_icmp().map_err(|error| format!("{}: {error}", privilege_guidance()))?;
    socket.set_nonblocking(true)?;
    Ok(UdpSocket::from_std(socket.into())?)
}
fn privilege_guidance() -> &'static str {
    if cfg!(target_os = "linux") {
        "Raw ICMP unavailable; use the dedicated icmp-launch helper with CAP_NET_RAW, not a root Ambra process (see docs/networking/pwnat.md)"
    } else if cfg!(target_os = "macos") {
        "Raw ICMP unavailable; launch through the installed one-shot icmp-launch helper using sudo (see docs/networking/pwnat.md)"
    } else {
        "pwnat is disabled on this platform"
    }
}
pub fn capability() -> Capability {
    match open_icmp() {
        Ok(_) => Capability {
            available: true,
            reason: "Raw ICMP socket available; router compatibility remains unverified".into(),
        },
        Err(error) => Capability {
            available: false,
            reason: format!("{}: {error}", privilege_guidance()),
        },
    }
}

pub fn checksum(bytes: &[u8]) -> u16 {
    let mut sum = 0_u32;
    for chunk in bytes.chunks(2) {
        sum += u16::from_be_bytes([chunk[0], *chunk.get(1).unwrap_or(&0)]) as u32;
    }
    while sum > 0xffff {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}
fn finish_checksum(packet: &mut [u8], offset: usize) {
    packet[offset..offset + 2].fill(0);
    let sum = checksum(packet);
    packet[offset..offset + 2].copy_from_slice(&sum.to_be_bytes());
}
pub fn echo(key: PublicKey) -> [u8; 8] {
    let mut packet = [8, 0, 0, 0, key.0[0], key.0[1], 0, 0];
    packet[6..8].copy_from_slice(&SEQUENCE.to_be_bytes());
    finish_checksum(&mut packet, 2);
    packet
}
pub fn time_exceeded(server: Ipv4Addr, key: PublicKey) -> Vec<u8> {
    let mut packet = vec![0; 36];
    packet[0] = 11;
    let ip = &mut packet[8..28];
    ip[0] = 0x45;
    ip[2..4].copy_from_slice(&28_u16.to_be_bytes());
    ip[8] = 1;
    ip[9] = 1;
    ip[12..16].copy_from_slice(&server.octets());
    ip[16..20].copy_from_slice(&ECHO_TARGET.octets());
    finish_checksum(ip, 10);
    packet[28..].copy_from_slice(&echo(key));
    finish_checksum(&mut packet, 2);
    packet
}
/// Raw sockets can include an outer IPv4 header. Validate all offsets before indexing.
pub fn validate_time_exceeded(packet: &[u8], key: PublicKey) -> bool {
    let packet = if packet.first().is_some_and(|b| b >> 4 == 4) {
        let header = ((packet[0] & 15) as usize) * 4;
        if header < 20 || packet.len() < header || packet[9] != 1 {
            return false;
        }
        &packet[header..]
    } else {
        packet
    };
    if packet.len() < 36 || packet[0] != 11 || packet[1] != 0 || checksum(packet) != 0 {
        return false;
    }
    let quoted = &packet[8..];
    let header = ((quoted[0] & 15) as usize) * 4;
    if quoted[0] >> 4 != 4
        || header < 20
        || quoted.len() < header + 8
        || checksum(&quoted[..header]) != 0
        || u16::from_be_bytes([quoted[2], quoted[3]]) as usize != header + 8
        || quoted[9] != 1
        || quoted[6] & 0x3f != 0
        || quoted[7] != 0
        || quoted[16..20] != ECHO_TARGET.octets()
    {
        return false;
    }
    // NATs may rewrite the quoted source address and checksum. Match the expected ICMP header.
    quoted[header..header + 8] == echo(key)
}

/// QUIC provides reliability, multiplexing, congestion control and keepalive.
/// Noise inside QUIC verifies Ambra's Ed25519 identity before any HTTP or token is sent.
/// The ephemeral TLS certificate is not used as an Ambra identity.
#[derive(Debug)]
struct NoiseAuthenticatesTls;
impl rustls::client::danger::ServerCertVerifier for NoiseAuthenticatesTls {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> std::result::Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
fn transport_config() -> Arc<quinn::TransportConfig> {
    let mut config = quinn::TransportConfig::default();
    config.keep_alive_interval(Some(Duration::from_secs(10)));
    config.max_idle_timeout(Some(
        Duration::from_secs(45).try_into().expect("valid timeout"),
    ));
    config.max_concurrent_bidi_streams(1_u8.into());
    config.max_concurrent_uni_streams(0_u8.into());
    Arc::new(config)
}
struct Bi {
    send: quinn::SendStream,
    recv: quinn::RecvStream,
}
impl AsyncRead for Bi {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        AsyncRead::poll_read(Pin::new(&mut self.recv), cx, buffer)
    }
}
impl AsyncWrite for Bi {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        AsyncWrite::poll_write(Pin::new(&mut self.send), cx, data)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        AsyncWrite::poll_flush(Pin::new(&mut self.send), cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        AsyncWrite::poll_shutdown(Pin::new(&mut self.send), cx)
    }
}

fn client_config() -> Result<quinn::ClientConfig> {
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .dangerous()
    .with_custom_certificate_verifier(Arc::new(NoiseAuthenticatesTls))
    .with_no_client_auth();
    let mut config = quinn::ClientConfig::new(Arc::new(
        quinn::crypto::rustls::QuicClientConfig::try_from(tls)?,
    ));
    config.transport_config(transport_config());
    Ok(config)
}

fn server_config() -> Result<quinn::ServerConfig> {
    let cert = rcgen::generate_simple_self_signed(vec!["ambra".into()])?;
    let mut config = quinn::ServerConfig::with_single_cert(
        vec![cert.cert.der().clone()],
        rustls::pki_types::PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
    )?;
    config.transport_config(transport_config());
    Ok(config)
}

pub async fn connect(
    server: SocketAddr,
    key: PublicKey,
    identity: &Identity,
) -> Result<(tokio::io::DuplexStream, transport::Pump)> {
    Client::default().connect(server, key, identity).await
}

/// Reuse the fixed-port QUIC socket through reconnects. A dropped QUIC endpoint
/// drains asynchronously; immediately rebinding its port otherwise fails.
#[derive(Default)]
pub struct Client {
    endpoint: std::sync::Mutex<Option<quinn::Endpoint>>,
}
impl Client {
    fn endpoint(&self, port: u16) -> Result<quinn::Endpoint> {
        let mut current = self.endpoint.lock().unwrap_or_else(|p| p.into_inner());
        if current
            .as_ref()
            .is_some_and(|e| e.local_addr().is_ok_and(|a| a.port() != port))
        {
            if let Some(old) = current.take() {
                old.close(0_u8.into(), b"endpoint changed");
            }
        }
        if current.is_none() {
            let mut endpoint =
                quinn::Endpoint::client(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)))?;
            endpoint.set_default_client_config(client_config()?);
            *current = Some(endpoint);
        }
        current
            .as_ref()
            .cloned()
            .ok_or_else(|| "pwnat endpoint initialization failed".into())
    }
    pub async fn connect(
        &self,
        server: SocketAddr,
        key: PublicKey,
        identity: &Identity,
    ) -> Result<(tokio::io::DuplexStream, transport::Pump)> {
        validate_endpoint(server)?;
        let mut stage = "icmp_socket";
        let mut signals = 0u32;
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(CONNECT_TIMEOUT, connect_inner(self, server, key, identity, &mut stage, &mut signals)).await;
        match result {
            Ok(Ok(connection)) => Ok(connection),
            result => {
                let detail = match result {
                    Ok(Err(error)) => error.to_string(),
                    Err(_) => "setup timed out; client NAT must translate ICMP errors and both NATs must preserve ICMP identifiers/UDP ports".to_owned(),
                    Ok(Ok(_)) => unreachable!(),
                };
                tracing::warn!(stage, icmp_requests=signals, elapsed_ms=started.elapsed().as_millis(), "pwnat setup failed");
                Err(format!("pwnat stage={stage} icmp_requests={signals}: {detail}").into())
            }
        }
    }
    pub fn shutdown(&self) {
        if let Some(endpoint) = self
            .endpoint
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            endpoint.close(0_u8.into(), b"shutdown");
        }
    }
}

struct Session(quinn::Connection);
impl Drop for Session {
    fn drop(&mut self) {
        self.0.close(0_u8.into(), b"session closed");
    }
}

async fn connect_inner(
    client: &Client,
    server: SocketAddr,
    key: PublicKey,
    identity: &Identity,
    stage: &mut &'static str,
    signals: &mut u32,
) -> Result<(tokio::io::DuplexStream, transport::Pump)> {
    let SocketAddr::V4(server) = server else {
        return Err("pwnat requires IPv4".into());
    };
    let raw = raw_socket()?;
    *stage = "udp_bind";
    let endpoint = client.endpoint(server.port())?;
    let message = time_exceeded(*server.ip(), key);
    tracing::info!(endpoint = %server, local = %endpoint.local_addr()?, "pwnat ICMP signaling and direct QUIC attempt; requires port-preserving NAT");
    let connection = endpoint.connect(SocketAddr::V4(server), "ambra")?;
    *stage = "quic_connect";
    tokio::pin!(connection);
    let connection = loop {
        raw.send_to(&message, SocketAddr::V4(SocketAddrV4::new(*server.ip(), 0)))
            .await?;
        *signals += 1;
        tokio::select! { result = &mut connection => break result?, _ = tokio::time::sleep(Duration::from_millis(300)) => {} }
    };
    *stage = "quic_stream";
    let (send, recv) = connection.open_bi().await?;
    *stage = "noise_identity";
    let (io, _, pump) = transport::secure(Bi { send, recv }, identity, Some(key)).await?;
    tracing::info!(peer = %key, endpoint = %connection.remote_address(), "pwnat authenticated direct QUIC/Noise stream; no LAN, DHT data stream or relay");
    // QUIC streams retain their connection; the Endpoint must also stay alive.
    // A guard attached to the pump owns the endpoint (see retain below).
    Ok((io, pump.retain(Box::new((endpoint, Session(connection))))))
}

pub async fn serve(
    address: SocketAddr,
    identity: Identity,
    app: axum::Router,
    cancel: CancellationToken,
    status: SharedStatus,
) -> Result<()> {
    struct Running(SharedStatus);
    impl Drop for Running {
        fn drop(&mut self) {
            let mut status = self.0.write().unwrap_or_else(|p| p.into_inner());
            status.running = false;
            status.listening = None;
            status.public_endpoint = None;
        }
    }
    // QUIC and raw ICMP share IPv4. An unspecified IPv6 management bind still
    // permits a separate IPv4 UDP listener; a concrete IPv6 bind cannot use pwnat.
    let address = match address {
        SocketAddr::V4(_) => address,
        SocketAddr::V6(a) if a.ip().is_unspecified() => (Ipv4Addr::UNSPECIFIED, a.port()).into(),
        _ => return Err("pwnat listener requires IPv4".into()),
    };
    let raw = raw_socket()?;
    let config = server_config()?;
    let socket = std::net::UdpSocket::bind(address)?;
    let address = socket.local_addr()?;
    socket.set_nonblocking(true)?;
    let punch = UdpSocket::from_std(socket.try_clone()?)?;
    let endpoint = quinn::Endpoint::new(
        quinn::EndpointConfig::default(),
        Some(config),
        socket,
        Arc::new(quinn::TokioRuntime),
    )?;
    {
        let mut status = status.write().unwrap_or_else(|p| p.into_inner());
        status.running = true;
        status.listening = Some(address);
        status.error = None;
    }
    let _running = Running(status.clone());
    tracing::info!(%address, "pwnat IPv4 QUIC listener ready; ICMP route/NAT compatibility unverified");
    let mut tasks = tokio::task::JoinSet::new();
    let mut interval = tokio::time::interval(Duration::from_secs(10));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut buffer = [0; 2048];
    let mut recent = std::collections::HashMap::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = interval.tick() => {
                recent.clear();
                match raw.send_to(&echo(identity.public_key()), SocketAddr::from((ECHO_TARGET, 0))).await {
                    Ok(_) => { status.write().unwrap_or_else(|p|p.into_inner()).icmp_echo_sent += 1; },
                    Err(error) => {
                        tracing::warn!(%error, "pwnat Echo transmission failed");
                        let mut status = status.write().unwrap_or_else(|p|p.into_inner());
                        status.icmp_errors += 1;
                        status.error = Some(format!("ICMP Echo transmission failed: {error}"));
                    }
                }
            },
            result = raw.recv_from(&mut buffer) => {
                let (length, source) = result?;
                if validate_endpoint(SocketAddr::new(source.ip(), 1)).is_ok() && validate_time_exceeded(&buffer[..length], identity.public_key()) && recent.len() < 16 && !recent.contains_key(&source.ip()) {
                    recent.insert(source.ip(), ());
                    status.write().unwrap_or_else(|p|p.into_inner()).icmp_quotations_accepted += 1;
                    let port = status.read().unwrap_or_else(|p| p.into_inner()).configured_endpoint.map_or(address.port(), |a| a.port());
                    let target = SocketAddr::new(source.ip(), port);
                    tracing::info!(%source, %target, "pwnat validated ICMP quotation; sending bounded UDP punches");
                    for _ in 0..3 {
                        match punch.send_to(b"AMBRA-PUNCH/1", target).await {
                            Ok(_) => { status.write().unwrap_or_else(|p|p.into_inner()).udp_punches_sent += 1; },
                            Err(error) => { tracing::warn!(%error, %target, "pwnat UDP punch failed"); break; }
                        }
                    }
                }
            },
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            Some(incoming) = endpoint.accept() => {
                if validate_endpoint(incoming.remote_address()).is_err() || tasks.len() >= 64 { incoming.refuse(); continue; }
                let identity = identity.clone(); let app = app.clone(); let cancel = cancel.clone();
                tasks.spawn(async move {
                    let setup = async {
                        let connection = incoming.await?;
                        let address = connection.remote_address();
                        let (send, recv) = connection.accept_bi().await?;
                        let (io, mut peer, pump) = transport::secure(Bi { send, recv }, &identity, None).await?;
                        peer.address = address;
                        tracing::info!(peer = %peer.public_key, endpoint = %address, "pwnat accepted authenticated direct QUIC/Noise stream; device authorization still required");
                        Ok::<_, crate::Error>((io, peer, pump.retain(Box::new(connection))))
                    };
                    match tokio::time::timeout(CONNECT_TIMEOUT, setup).await {
                        Ok(Ok((io, peer, pump))) => { if let Err(error) = transport::serve(io, pump, peer, app, cancel).await { tracing::debug!(%error, "pwnat HTTP session closed"); } },
                        Ok(Err(error)) => tracing::warn!(%error, "pwnat QUIC/Noise setup failed"),
                        Err(_) => tracing::warn!("pwnat incoming QUIC/Noise setup timed out"),
                    }
                });
            }
        }
    }
    endpoint.close(0_u8.into(), b"shutdown");
    tasks.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn client_reuses_fixed_port_while_previous_session_still_owns_endpoint() {
        let client = Client::default();
        let previous = client.endpoint(0).unwrap();
        let address = previous.local_addr().unwrap();
        // A new endpoint cannot bind while QUIC drains the previous session.
        assert!(quinn::Endpoint::client(address).is_err());
        let reconnected = client.endpoint(address.port()).unwrap();
        assert_eq!(reconnected.local_addr().unwrap(), address);
        client.shutdown();
    }

    #[tokio::test]
    async fn quic_noise_rejects_wrong_pinned_key_before_http_or_tokens() {
        tokio::time::timeout(Duration::from_secs(3), async {
            let identity = Identity::generate().unwrap();
            let server =
                quinn::Endpoint::server(server_config().unwrap(), "127.0.0.1:0".parse().unwrap())
                    .unwrap();
            let address = server.local_addr().unwrap();
            let task = tokio::spawn(async move {
                let connection = server.accept().await.unwrap().await.unwrap();
                let (send, recv) = connection.accept_bi().await.unwrap();
                let _ = transport::secure(Bi { send, recv }, &identity, None).await;
            });
            let mut client = quinn::Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
            client.set_default_client_config(client_config().unwrap());
            let connection = client.connect(address, "ambra").unwrap().await.unwrap();
            let (send, recv) = connection.open_bi().await.unwrap();
            let wrong = Identity::generate().unwrap().public_key();
            assert!(
                transport::secure(
                    Bi { send, recv },
                    &Identity::generate().unwrap(),
                    Some(wrong)
                )
                .await
                .is_err()
            );
            connection.close(0_u8.into(), b"test complete");
            task.await.unwrap();
        })
        .await
        .expect("wrong-key handshake must terminate");
    }

    #[test]
    fn capability_probe_does_not_require_a_tokio_runtime_or_elevation() {
        let result = capability();
        assert!(!result.reason.is_empty());
        assert_eq!(
            platform_supported(),
            cfg!(any(target_os = "linux", target_os = "macos"))
        );
        if !platform_supported() {
            assert!(!result.available);
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn inherited_descriptor_rejects_closed_fds_files_and_udp_without_taking_ownership() {
        use std::os::fd::AsRawFd;
        assert!(inherited_socket(-1).is_err());
        let file = tempfile::tempfile().unwrap();
        assert!(inherited_socket(file.as_raw_fd()).is_err());
        assert!(file.metadata().is_ok());
        let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        assert!(inherited_socket(udp.as_raw_fd()).is_err());
        assert!(udp.local_addr().is_ok());
    }

    #[test]
    fn endpoints_reject_private_overlay_reserved_ipv6_and_zero_ports() {
        for address in [
            "0.1.2.3:1",
            "10.0.0.1:1",
            "127.0.0.1:1",
            "169.254.1.1:1",
            "172.16.0.1:1",
            "192.168.0.1:1",
            "100.64.0.1:1",
            "100.127.255.254:1",
            "192.0.0.1:1",
            "192.0.2.1:1",
            "198.18.0.1:1",
            "198.19.0.1:1",
            "198.51.100.1:1",
            "203.0.113.1:1",
            "224.1.1.1:1",
            "240.0.0.1:1",
            "255.255.255.255:1",
            "8.8.8.8:0",
            "[::ffff:8.8.8.8]:1",
            "[2606:4700::1111]:1",
        ] {
            assert!(
                validate_endpoint(address.parse().unwrap()).is_err(),
                "{address}"
            );
        }
        for address in ["8.8.8.8:38149", "100.63.255.255:1", "100.128.0.1:65535"] {
            assert!(
                validate_endpoint(address.parse().unwrap()).is_ok(),
                "{address}"
            );
        }
    }

    #[test]
    fn endpoint_records_are_bounded_fresh_versioned_and_public_only() {
        let endpoint = "8.8.8.8:38149".parse().unwrap();
        let bytes = EndpointRecord::encode(endpoint, 1000).unwrap();
        assert_eq!(EndpointRecord::decode(&bytes, 1000).unwrap(), endpoint);
        assert!(EndpointRecord::decode(&bytes, 1180).is_err());
        assert!(EndpointRecord::decode(&bytes, 999).is_ok());
        assert!(EndpointRecord::decode(&bytes, 969).is_err());
        assert!(EndpointRecord::decode(&vec![0; 513], 1000).is_err());
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        for (field, replacement) in [
            ("endpoint", serde_json::json!("100.106.252.60:38149")),
            ("protocol", serde_json::json!("other/1")),
            ("privateAddress", serde_json::json!("192.168.1.1")),
        ] {
            let mut bad = value.clone();
            bad[field] = replacement;
            assert!(EndpointRecord::decode(&serde_json::to_vec(&bad).unwrap(), 1000).is_err());
        }
    }

    #[test]
    fn signed_endpoint_storage_rejects_forgery_and_payload_tampering() {
        use peeroxide_dht::{
            crypto, hyperdht_messages as messages,
            persistent::{HandlerReply, IncomingHyperRequest, Persistent},
        };
        let identity = Identity::generate().unwrap().key_pair();
        let attacker = Identity::generate().unwrap().key_pair();
        let value = EndpointRecord::encode("8.8.8.8:38149".parse().unwrap(), 1000).unwrap();
        let signable = crypto::mutable_signable(&crypto::NS_MUTABLE_PUT, 1000, &value);
        let signature = crypto::sign_detached(&signable, &identity.secret_key);
        let put = |value: Vec<u8>, signature| IncomingHyperRequest {
            command: messages::MUTABLE_PUT,
            target: Some(crypto::hash(&identity.public_key)),
            token: Some([0; 32]),
            value: Some(
                messages::encode_mutable_put_request_to_bytes(&messages::MutablePutRequest {
                    public_key: identity.public_key,
                    seq: 1000,
                    value,
                    signature,
                })
                .unwrap(),
            ),
            from: peeroxide_dht::messages::Ipv4Peer {
                host: "127.0.0.1".into(),
                port: 1,
            },
            id: None,
        };
        let mut storage = Persistent::new(Default::default());
        let forged = crypto::sign_detached(&signable, &attacker.secret_key);
        assert!(matches!(
            storage.on_mutable_put(&put(value.clone(), forged)),
            HandlerReply::Silent
        ));
        let modified = EndpointRecord::encode("9.9.9.9:38149".parse().unwrap(), 1000).unwrap();
        assert!(matches!(
            storage.on_mutable_put(&put(modified, signature)),
            HandlerReply::Silent
        ));
        assert!(matches!(
            storage.on_mutable_put(&put(value, signature)),
            HandlerReply::Value(None)
        ));
    }

    #[tokio::test]
    async fn invalid_endpoint_fails_before_privilege_or_network_access() {
        let identity = Identity::generate().unwrap();
        for endpoint in ["100.106.252.60:38149", "0.0.0.0:0", "[::1]:38149"] {
            let error = connect(endpoint.parse().unwrap(), identity.public_key(), &identity)
                .await
                .err()
                .unwrap();
            assert!(error.to_string().contains("IPv4"));
        }
    }
    /// This proves QUIC/Noise compatibility only. It is NOT a pwnat/NAT traversal test.
    #[tokio::test]
    async fn quic_and_noise_exchange_authenticated_bytes_without_raw_socket_privileges() {
        let server_identity = Identity::generate().unwrap();
        let key = server_identity.public_key();
        let server =
            quinn::Endpoint::server(server_config().unwrap(), "127.0.0.1:0".parse().unwrap())
                .unwrap();
        let address = server.local_addr().unwrap();
        let server_task = tokio::spawn(async move {
            let connection = server.accept().await.unwrap().await.unwrap();
            let (send, recv) = connection.accept_bi().await.unwrap();
            let (io, _, _pump) = transport::secure(Bi { send, recv }, &server_identity, None)
                .await
                .unwrap();
            let (mut read, mut write) = tokio::io::split(io);
            let _ = tokio::io::copy(&mut read, &mut write).await;
            drop(connection);
            server.close(0_u8.into(), b"test complete");
        });
        let mut client = quinn::Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
        client.set_default_client_config(client_config().unwrap());
        let connection = client.connect(address, "ambra").unwrap().await.unwrap();
        let (send, recv) = connection.open_bi().await.unwrap();
        let (mut io, _, pump) =
            transport::secure(Bi { send, recv }, &Identity::generate().unwrap(), Some(key))
                .await
                .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            for _ in 0..128 {
                io.write_all(&[37; 1024]).await.unwrap();
                let mut echoed = [0; 1024];
                io.read_exact(&mut echoed).await.unwrap();
                assert_eq!(echoed, [37; 1024]);
            }
        })
        .await
        .unwrap();
        drop(io);
        drop(pump);
        connection.close(0_u8.into(), b"done");
        client.close(0_u8.into(), b"done");
        tokio::time::timeout(Duration::from_secs(2), server_task)
            .await
            .unwrap()
            .unwrap();
    }
}
