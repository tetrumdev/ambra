//! Answers clients looking for an Ambra server on the local network.
//!
//! A client broadcasts `DISCOVERY_REQUEST` to UDP port `DISCOVERY_PORT`; each server replies
//! to the sender with its `ServerInfo` as JSON. Nothing secret is sent: using the server
//! still needs pairing.

use std::net::SocketAddr;

use tokio::net::UdpSocket;

use crate::network::{SharedNetwork, server_info};

pub const DISCOVERY_PORT: u16 = 38148;
pub const DISCOVERY_REQUEST: &[u8] = b"AMBRA-DISCOVER/1";

pub async fn run(network: SharedNetwork) {
    let socket = match UdpSocket::bind(SocketAddr::from(([0, 0, 0, 0], DISCOVERY_PORT))).await {
        Ok(socket) => socket,
        Err(error) => {
            eprintln!("Network discovery is off: could not listen on UDP {DISCOVERY_PORT}: {error}");
            return;
        }
    };
    let mut buffer = [0_u8; 64];
    loop {
        let Ok((length, sender)) = socket.recv_from(&mut buffer).await else {
            continue;
        };
        if &buffer[..length] != DISCOVERY_REQUEST {
            continue;
        }
        let enabled = network.config.read().map(|config| config.discovery).unwrap_or(false);
        if !enabled {
            continue;
        }
        if let Ok(reply) = serde_json::to_vec(&server_info(&network)) {
            let _ = socket.send_to(&reply, sender).await;
        }
    }
}
