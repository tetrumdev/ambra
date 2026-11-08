//! Admission control for every path reachable from the internet.
//!
//! An internet-facing listener must never answer someone who is not a paired device:
//! no handshake, no server key, no error, not a single byte. Scanners and anyone who
//! learned the server's address or public key see a port that closes silently.
//!
//! Public TCP: before the Noise handshake the client sends a fixed-size "knock" signed
//! by its device key. The server reads exactly [`KNOCK_LEN`] bytes, checks the signature
//! against its list of paired device keys, and only then starts Noise. The Noise peer
//! must be the same key that knocked. The knock rides in the same flight as the first
//! Noise message, so it costs no round trip.
//!
//! HyperDHT: the client's static key arrives inside the first IK handshake message, so
//! the server drops unpaired keys before replying (see `peeroxide::SwarmConfig::admit`).
use crate::{Identity, PublicKey};
use peeroxide_dht::crypto::{sign_detached, verify_detached};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Decides whether a device key may reach the server over an internet path.
pub type Admit = Arc<dyn Fn(&PublicKey) -> bool + Send + Sync>;

/// Admits every key. For tests and for listeners that are not internet-facing.
pub fn admit_all() -> Admit {
    Arc::new(|_| true)
}

const DOMAIN: &[u8] = b"ambra/knock/v1";
/// Leads every knock. As a SecretStream uint24 frame length this would announce a
/// 16 MiB handshake frame, so it can never be confused with the start of Noise.
pub const MARKER: [u8; 4] = [0xff, 0xff, 0xff, 0x01];
/// Marker (4) + client key (32) + Unix milliseconds (8) + nonce (16) + Ed25519 signature (64).
pub const KNOCK_LEN: usize = 4 + 32 + 8 + 16 + 64;
/// Accepted clock difference between device and server.
const SKEW: Duration = Duration::from_secs(30 * 60);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn signable(server: &PublicKey, client: &[u8], timestamp: &[u8], nonce: &[u8]) -> Vec<u8> {
    [DOMAIN, &server.0, client, timestamp, nonce].concat()
}

/// Builds the knock a paired device sends before the Noise handshake.
pub fn knock(identity: &Identity, server: PublicKey) -> [u8; KNOCK_LEN] {
    let pair = identity.key_pair();
    let timestamp = now_ms().to_le_bytes();
    let mut nonce = [0u8; 16];
    let _ = getrandom::fill(&mut nonce);
    let signature = sign_detached(&signable(&server, &pair.public_key, &timestamp, &nonce), &pair.secret_key);
    let mut out = [0u8; KNOCK_LEN];
    out[..4].copy_from_slice(&MARKER);
    out[4..36].copy_from_slice(&pair.public_key);
    out[36..44].copy_from_slice(&timestamp);
    out[44..60].copy_from_slice(&nonce);
    out[60..].copy_from_slice(&signature);
    out
}

/// Remembers recent nonces so an observed knock cannot be replayed.
#[derive(Default)]
pub struct Replay(Mutex<HashMap<[u8; 16], u64>>);
impl Replay {
    const MAX: usize = 16_384;
    fn fresh(&self, nonce: [u8; 16], now: u64) -> bool {
        let Ok(mut seen) = self.0.lock() else { return false };
        let horizon = now.saturating_sub(2 * SKEW.as_millis() as u64);
        if seen.len() >= Self::MAX {
            seen.retain(|_, at| *at > horizon);
            if seen.len() >= Self::MAX { return false; }
        }
        seen.insert(nonce, now).is_none()
    }
}

/// Returns the knocking device's key when the knock is fresh, unreplayed, correctly
/// signed for this server, and from a key `admit` accepts. Anything else is `None`.
pub fn check_knock(bytes: &[u8; KNOCK_LEN], server: PublicKey, admit: &Admit, replay: &Replay) -> Option<PublicKey> {
    if bytes[..4] != MARKER { return None; }
    let bytes = &bytes[4..];
    let client = PublicKey(bytes[..32].try_into().ok()?);
    // Cheapest checks first: an unknown key never costs a signature verification.
    if !admit(&client) { return None; }
    let timestamp = u64::from_le_bytes(bytes[32..40].try_into().ok()?);
    let now = now_ms();
    if timestamp.abs_diff(now) > SKEW.as_millis() as u64 { return None; }
    let signature: [u8; 64] = bytes[56..].try_into().ok()?;
    if !verify_detached(&signature, &signable(&server, &client.0, &bytes[32..40], &bytes[40..56]), &client.0) {
        return None;
    }
    replay.fresh(bytes[40..56].try_into().ok()?, now).then_some(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fresh_signed_knocks_from_admitted_keys_pass_once() {
        let server = Identity::generate().unwrap().public_key();
        let device = Identity::generate().unwrap();
        let stranger = Identity::generate().unwrap();
        let paired = device.public_key();
        let admit: Admit = Arc::new(move |key| *key == paired);
        let replay = Replay::default();

        let good = knock(&device, server);
        assert_eq!(check_knock(&good, server, &admit, &replay), Some(paired));
        assert_eq!(check_knock(&good, server, &admit, &replay), None, "replayed knock");

        assert_eq!(check_knock(&knock(&stranger, server), server, &admit, &replay), None, "unpaired key");
        let other_server = Identity::generate().unwrap().public_key();
        assert_eq!(check_knock(&knock(&device, other_server), server, &admit, &replay), None, "wrong server");

        let mut forged = knock(&device, server);
        forged[70] ^= 1;
        assert_eq!(check_knock(&forged, server, &admit, &replay), None, "bad signature");

        let mut stale = knock(&device, server);
        stale[36..44].copy_from_slice(&(now_ms() - 3_600_000).to_le_bytes());
        assert_eq!(check_knock(&stale, server, &admit, &replay), None, "stale timestamp");

        let mut spoofed = knock(&stranger, server);
        spoofed[4..36].copy_from_slice(&paired.0);
        assert_eq!(check_knock(&spoofed, server, &admit, &replay), None, "claimed someone else's key");
    }
}
