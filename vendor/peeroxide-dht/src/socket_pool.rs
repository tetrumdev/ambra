//! Shared UDP socket pool used by NAT hole-punching.
//!
//! `SocketPool` hands out `SocketRef` references to ephemeral UDP
//! sockets bound on local ports, multiplexing receive of incoming
//! `PEER_HOLEPUNCH` probes through a dedicated channel (`HolepunchEvent`).
//! The [`crate::holepuncher::Holepuncher`] uses this pool to launch the
//! birthday-attack probe sequence required to traverse symmetric NATs.
//!
//! Most consumers use the pool indirectly via
//! [`crate::hyperdht::HyperDhtHandle::connect`]; direct use is only needed
//! for custom DHT-server orchestration or low-level hole-punch experiments.

#![allow(missing_docs)]

use std::net::SocketAddr;

use libudx::{Datagram, UdxRuntime, UdxSocket};
use tokio::sync::mpsc;

type ProbeHandler = Box<dyn FnMut(HolepunchEvent, &UdxSocket) + Send>;

const HOLEPUNCH_MSG: &[u8] = &[0];
const HOLEPUNCH_TTL: u32 = 5;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum SocketPoolError {
    #[error("overlay endpoint excluded")]
    OverlayExcluded,
    #[error("udx error: {0}")]
    Udx(#[from] libudx::UdxError),
    #[error("invalid address: {0}")]
    AddrParse(#[from] std::net::AddrParseError),
}

pub type Result<T> = std::result::Result<T, SocketPoolError>;

pub struct SocketPool {
    host: String,
}

impl SocketPool {
    pub fn new(host: String) -> Self {
        Self { host }
    }

    pub async fn acquire(&self, runtime: &UdxRuntime) -> Result<SocketRef> {
        self.acquire_routed(runtime, None).await
    }

    /// Production punchers handle probes in the router, avoiding a second task
    /// and channel hop for each of the 256 birthday sockets.
    pub(crate) async fn acquire_with_probe_handler(
        &self,
        runtime: &UdxRuntime,
        handler: impl FnMut(HolepunchEvent, &UdxSocket) + Send + 'static,
    ) -> Result<SocketRef> {
        self.acquire_routed(runtime, Some(Box::new(handler))).await
    }

    async fn acquire_routed(
        &self,
        runtime: &UdxRuntime,
        handler: Option<ProbeHandler>,
    ) -> Result<SocketRef> {
        let socket = runtime.create_socket().await?;
        let addr: SocketAddr = format!("{}:0", self.host).parse()?;
        socket.bind(addr).await?;
        // Tokio's first try_send_to needs an initial writable readiness event.
        // Wait before scoped TTL changes; never defer a low-TTL probe send.
        socket.writable().await?;

        let (hp_tx, hp_rx) = mpsc::unbounded_channel();
        let (dht_tx, dht_rx) = mpsc::unbounded_channel();
        let recv_rx = socket.recv_start()?;

        let recv_task = tokio::spawn(route_messages(
            recv_rx,
            hp_tx,
            dht_tx,
            handler.map(|handler| (handler, socket.clone())),
        ));

        Ok(SocketRef {
            socket,
            holepunch_rx: Some(hp_rx),
            dht_reply_rx: Some(dht_rx),
            _recv_task: Some(recv_task),
        })
    }
}

async fn route_messages(
    mut recv_rx: mpsc::UnboundedReceiver<Datagram>,
    hp_tx: mpsc::UnboundedSender<HolepunchEvent>,
    dht_tx: mpsc::UnboundedSender<Datagram>,
    mut handler: Option<(ProbeHandler, UdxSocket)>,
) {
    while let Some(dgram) = recv_rx.recv().await {
        match classify_inbound(&dgram.data) {
            InboundClass::Holepunch => {
                tracing::debug!(addr = %dgram.addr, len = dgram.data.len(), "socket_pool: holepunch probe received");
                let event = HolepunchEvent { addr: dgram.addr };
                if let Some((handler, socket)) = &mut handler {
                    handler(event, socket);
                } else {
                    let _ = hp_tx.send(event);
                }
            }
            InboundClass::DhtResponse => {
                tracing::trace!(addr = %dgram.addr, len = dgram.data.len(), "socket_pool: DHT response forwarded");
                let _ = dht_tx.send(dgram);
            }
            InboundClass::UdxFrame | InboundClass::Drop => {
                // UDX frames are handled by libudx's own demux before fallback
                // datagrams reach this lane; DHT requests are not expected on
                // a holepunch socket; both are silently dropped.
            }
        }
    }
}

#[derive(Debug)]
#[non_exhaustive]
pub struct HolepunchEvent {
    pub addr: SocketAddr,
}

pub struct SocketRef {
    pub socket: UdxSocket,
    pub holepunch_rx: Option<mpsc::UnboundedReceiver<HolepunchEvent>>,
    pub dht_reply_rx: Option<mpsc::UnboundedReceiver<Datagram>>,
    _recv_task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for SocketRef {
    fn drop(&mut self) {
        if let Some(task) = self._recv_task.take() {
            task.abort();
        }
    }
}

impl SocketRef {
    /// The holepunch receiver is `Some(...)` immediately after `SocketPool::acquire()`.
    /// The Holepuncher recv-adapter takes ownership through this accessor exactly once;
    /// subsequent calls return `None`.
    pub fn take_holepunch_rx(&mut self) -> Option<mpsc::UnboundedReceiver<HolepunchEvent>> {
        self.holepunch_rx.take()
    }

    /// Take ownership of the DHT-reply receiver. Datagrams whose payload
    /// `messages::decode_message` parses as a `Message::Response` are
    /// forwarded here. Used by `Nat::auto_sample` to receive PING-via-socket
    /// replies through the puncher socket's own NAT mapping.
    pub fn take_dht_reply_rx(&mut self) -> Option<mpsc::UnboundedReceiver<Datagram>> {
        self.dht_reply_rx.take()
    }

    pub fn send_holepunch(&self, addr: SocketAddr, low_ttl: bool) -> Result<()> {
        if crate::address_policy::is_overlay(addr.ip()) {
            return Err(SocketPoolError::OverlayExcluded);
        }
        if low_ttl {
            self.socket
                .send_to_with_ttl(HOLEPUNCH_MSG, addr, HOLEPUNCH_TTL)?;
        } else {
            self.socket.send_to(HOLEPUNCH_MSG, addr)?;
        }
        Ok(())
    }

    pub fn send_holepunch_to(&self, host: &str, port: u16, low_ttl: bool) -> Result<()> {
        let addr: SocketAddr = format!("{host}:{port}").parse()?;
        self.send_holepunch(addr, low_ttl)
    }
}

pub fn random_port() -> u16 {
    1000 + (rand::random::<f64>() * 64536.0) as u16
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InboundClass {
    Holepunch,
    UdxFrame,
    DhtResponse,
    Drop,
}

/// Classify an inbound datagram on a holepunch socket. UDX frames are
/// libudx's responsibility (demuxed before they reach this lane) so they
/// are dropped defensively; `decode_message` parses the rest, forwarding
/// only well-formed `Message::Response` datagrams.
pub(crate) fn classify_inbound(buf: &[u8]) -> InboundClass {
    if buf.len() <= 1 {
        return InboundClass::Holepunch;
    }
    if buf.len() >= 20 && buf[0] == 0xFF {
        return InboundClass::UdxFrame;
    }
    match crate::messages::decode_message(buf) {
        Ok(crate::messages::Message::Response(_)) => InboundClass::DhtResponse,
        _ => InboundClass::Drop,
    }
}

/// Map a raw `firewall` value into the punch-strategy bucket the Holepuncher
/// dispatcher understands.
///
/// Matches Node `hyperdht/lib/holepuncher.js:333-335`: only `OPEN →
/// CONSISTENT`. `UNKNOWN` no longer gets silently coerced — by the time
/// `punch()` runs the puncher's `Nat` has been seeded by
/// [`crate::holepuncher::Holepuncher::auto_sample`] which settles the
/// firewall to `CONSISTENT` / `RANDOM` via real reflexive samples.
pub fn coerce_firewall(fw: u64) -> u64 {
    use crate::hyperdht_messages::{FIREWALL_CONSISTENT, FIREWALL_OPEN};
    if fw == FIREWALL_OPEN {
        FIREWALL_CONSISTENT
    } else {
        fw
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hyperdht_messages::{
        FIREWALL_CONSISTENT, FIREWALL_OPEN, FIREWALL_RANDOM, FIREWALL_UNKNOWN,
    };

    #[tokio::test]
    async fn holepunch_probes_preserve_socket_default_ttl() {
        let runtime = UdxRuntime::new().unwrap();
        let socket = SocketPool::new("127.0.0.1".into())
            .acquire(&runtime)
            .await
            .unwrap();
        socket.socket.set_ttl(93).unwrap();
        let addr = socket.socket.local_addr().await.unwrap();

        socket.send_holepunch(addr, true).unwrap();
        assert_eq!(socket.socket.ttl().unwrap(), 93);
        socket.send_holepunch(addr, false).unwrap();
        assert_eq!(socket.socket.ttl().unwrap(), 93);
        socket.socket.send_to(b"reflection", addr).unwrap();
        tokio::task::yield_now().await;
        assert_eq!(socket.socket.ttl().unwrap(), 93);
    }

    #[test]
    fn random_port_in_range() {
        for _ in 0..1000 {
            let p = random_port();
            assert!(p >= 1000);
        }
    }

    #[test]
    fn coerce_open_to_consistent() {
        assert_eq!(coerce_firewall(FIREWALL_OPEN), FIREWALL_CONSISTENT);
    }

    #[test]
    fn coerce_consistent_unchanged() {
        assert_eq!(coerce_firewall(FIREWALL_CONSISTENT), FIREWALL_CONSISTENT);
    }

    #[test]
    fn coerce_random_unchanged() {
        assert_eq!(coerce_firewall(FIREWALL_RANDOM), FIREWALL_RANDOM);
    }

    #[test]
    fn coerce_unknown_unchanged() {
        assert_eq!(coerce_firewall(FIREWALL_UNKNOWN), FIREWALL_UNKNOWN);
    }

    #[test]
    fn demux_routes_one_byte_to_holepunch() {
        let buf = [0u8; 1];
        assert_eq!(classify_inbound(&buf), InboundClass::Holepunch);
    }

    #[test]
    fn demux_drops_udx_framed_packet() {
        let mut buf = vec![0u8; 25];
        buf[0] = 0xFF;
        assert_eq!(
            classify_inbound(&buf),
            InboundClass::UdxFrame,
            "25-byte 0xFF-prefix packet must classify as UdxFrame (stub returns Drop — RED)",
        );
    }

    #[test]
    fn demux_routes_dht_response_to_reply_lane() {
        use crate::messages::{Ipv4Peer, Response, encode_response_to_bytes};
        let resp = Response {
            tid: 1,
            to: Ipv4Peer {
                host: "127.0.0.1".into(),
                port: 9000,
            },
            id: None,
            token: None,
            closer_nodes: vec![],
            error: 0,
            value: None,
        };
        let buf = encode_response_to_bytes(&resp).unwrap();
        assert_eq!(
            classify_inbound(&buf),
            InboundClass::DhtResponse,
            "valid DHT Response bytes must classify as DhtResponse (stub returns Drop — RED)",
        );
    }
}

#[cfg(test)]
mod lifetime_tests {
    use super::*;
    #[tokio::test]
    async fn low_ttl_probe_restores_ttl_and_drop_stops_router() {
        let runtime = UdxRuntime::new().unwrap();
        let pool = SocketPool::new("127.0.0.1".into());
        let socket = pool.acquire(&runtime).await.unwrap();
        let address = socket.socket.local_addr().await.unwrap();
        let receiver = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let ttl = socket.socket.ttl().unwrap();
        socket
            .send_holepunch(receiver.local_addr().unwrap(), true)
            .unwrap();
        assert_eq!(socket.socket.ttl().unwrap(), ttl);
        let mut bytes = [0; 8];
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            receiver.recv_from(&mut bytes),
        )
        .await
        .unwrap()
        .unwrap();
        let task = socket._recv_task.as_ref().unwrap().abort_handle();
        drop(socket);
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        assert!(task.is_finished());
        tokio::net::UdpSocket::bind(address)
            .await
            .expect("socket router retained UDP binding");
    }
}
