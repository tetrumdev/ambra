//! Independent implementation from Autonomous NAT Traversal (P2P'10) and RFC 792.
//! No upstream pwnat implementation was read, translated, linked, or executed.
//! This bounded variant supports IPv4 NATs that preserve agreed ICMP identifiers and UDP ports.
use crate::{Identity, PublicKey, Result, transport};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::Arc,
    time::Duration,
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

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub available: bool,
    pub reason: String,
}

fn raw_socket() -> Result<UdpSocket> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        Err("Raw ICMP is unavailable in the supported mobile sandbox".into())
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let socket = Socket::new(Domain::IPV4, Type::RAW, Some(Protocol::ICMPV4))?;
        socket.set_nonblocking(true)?;
        socket.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into())?;
        Ok(UdpSocket::from_std(socket.into())?)
    }
}
pub fn capability() -> Capability {
    match raw_socket() {
        Ok(_) => Capability {
            available: true,
            reason: "Raw ICMP socket available; router compatibility remains unverified".into(),
        },
        Err(error) => Capability {
            available: false,
            reason: format!("Raw ICMP unavailable without elevation: {error}"),
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
    let SocketAddr::V4(server) = server else {
        return Err("pwnat requires IPv4".into());
    };
    if crate::lan::is_local((*server.ip()).into()) || peeroxide_dht::address_policy::is_overlay((*server.ip()).into()) {
        return Err("pwnat requires a known public endpoint".into());
    }
    let raw = raw_socket()?;
    let mut endpoint =
        quinn::Endpoint::client(SocketAddr::from((Ipv4Addr::UNSPECIFIED, server.port())))?;
    endpoint.set_default_client_config(client_config()?);
    let message = time_exceeded(*server.ip(), key);
    let connection = endpoint.connect(SocketAddr::V4(server), "ambra")?;
    tokio::pin!(connection);
    let connection = loop {
        raw.send_to(&message, SocketAddr::V4(SocketAddrV4::new(*server.ip(), 0)))
            .await?;
        tokio::select! { result = &mut connection => break result?, _ = tokio::time::sleep(Duration::from_millis(300)) => {} }
    };
    let (send, recv) = connection.open_bi().await?;
    let (io, _, pump) = transport::secure(Bi { send, recv }, identity, Some(key)).await?;
    // QUIC streams retain their connection; the Endpoint must also stay alive.
    // A guard attached to the pump owns the endpoint (see retain below).
    Ok((io, pump.retain(Box::new((endpoint, connection)))))
}

pub async fn serve(
    address: SocketAddr,
    identity: Identity,
    app: axum::Router,
    cancel: CancellationToken,
) -> Result<()> {
    let raw = raw_socket()?;
    let config = server_config()?;
    let socket = std::net::UdpSocket::bind(address)?;
    socket.set_nonblocking(true)?;
    let punch = UdpSocket::from_std(socket.try_clone()?)?;
    let endpoint = quinn::Endpoint::new(
        quinn::EndpointConfig::default(),
        Some(config),
        socket,
        Arc::new(quinn::TokioRuntime),
    )?;
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
                let _ = raw.send_to(&echo(identity.public_key()), SocketAddr::from((ECHO_TARGET, 0))).await;
            },
            result = raw.recv_from(&mut buffer) => {
                let (length, source) = result?;
                if !crate::lan::is_local(source.ip()) && !peeroxide_dht::address_policy::is_overlay(source.ip()) && validate_time_exceeded(&buffer[..length], identity.public_key()) && recent.len() < 16 && !recent.contains_key(&source.ip()) {
                    recent.insert(source.ip(), ());
                    let target = SocketAddr::new(source.ip(), address.port());
                    for _ in 0..3 { let _ = punch.send_to(b"AMBRA-PUNCH/1", target).await; }
                }
            },
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            Some(incoming) = endpoint.accept() => {
                if peeroxide_dht::address_policy::is_overlay(incoming.remote_address().ip()) || tasks.len() >= 64 { incoming.refuse(); continue; }
                let identity = identity.clone(); let app = app.clone(); let cancel = cancel.clone();
                tasks.spawn(async move {
                    let setup = async {
                        let connection = incoming.await?;
                        let address = connection.remote_address();
                        let (send, recv) = connection.accept_bi().await?;
                        let (io, mut peer, pump) = transport::secure(Bi { send, recv }, &identity, None).await?;
                        peer.address = address;
                        Ok::<_, crate::Error>((io, peer, pump.retain(Box::new(connection))))
                    };
                    if let Ok(Ok((io, peer, pump))) = tokio::time::timeout(Duration::from_secs(5), setup).await { let _ = transport::serve(io, pump, peer, app, cancel).await; }
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
