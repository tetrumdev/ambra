//! Nostr carries only small, authenticated control messages. It never carries application bytes.
use crate::{Identity, PublicKey, Result};
use futures_util::{Stream, StreamExt};
use nostr::{nips::nip44, prelude::*};
use nostr_sdk::prelude::{Client, ClientNotification, RelayLimits, RelayOptions, RelayStatus};
use peeroxide_dht::crypto::{sign_detached, verify_detached};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    num::NonZeroUsize,
    pin::Pin,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const RELAYS: [&str; 2] = ["wss://relay.primal.net", "wss://relay.nostr.net"];
pub const SIGNAL_KIND: Kind = Kind::Custom(28333);
const BINDING_KIND: Kind = Kind::Custom(30078);
const MAX_CONTENT: usize = 8192;
const LIFETIME: u64 = 90;
const SKEW: u64 = 30;
const DOMAIN: &[u8] = b"ambra/nostr/control/v1\0";

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn nonce() -> Result<String> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(hex::encode(bytes))
}
fn valid_nonce(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn identifier(key: PublicKey) -> String {
    format!("ambra/signaling/v1/{key}")
}
fn signature<T: Serialize>(identity: &Identity, value: &T) -> Result<String> {
    let bytes = [DOMAIN, serde_json::to_vec(value)?.as_slice()].concat();
    Ok(hex::encode(sign_detached(
        &bytes,
        &identity.key_pair().secret_key,
    )))
}
fn verify<T: Serialize>(key: PublicKey, value: &T, signature: &str) -> Result<()> {
    let mut sig = [0; 64];
    hex::decode_to_slice(signature, &mut sig)?;
    let bytes = [DOMAIN, serde_json::to_vec(value)?.as_slice()].concat();
    if !verify_detached(&sig, &bytes, &key.0) {
        return Err("Invalid Ambra signaling signature".into());
    }
    Ok(())
}

/// Public identity binding, discoverable by an already paired Ed25519 key. No candidates,
/// session identifiers or credentials are present. Both signatures must verify.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub version: u8,
    pub device: PublicKey,
    pub nostr: nostr::key::PublicKey,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedBinding {
    binding: Binding,
    signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Message {
    Offer {
        candidates: Vec<crate::tcp_punch::Candidate>,
    },
    Answer {
        candidates: Vec<crate::tcp_punch::Candidate>,
    },
    Ready {},
    Start {
        at_ms: u64,
    },
    Connected {},
    Failed {},
}
impl Message {
    fn phase(&self) -> &'static str {
        match self {
            Self::Offer { .. } => "offer",
            Self::Answer { .. } => "answer",
            Self::Ready {} => "ready",
            Self::Start { .. } => "start",
            Self::Connected {} => "connected",
            Self::Failed {} => "failed",
        }
    }
    fn validate(&self) -> Result<()> {
        match self {
            Self::Offer { candidates } | Self::Answer { candidates } => {
                if candidates.is_empty() || candidates.len() > 4 {
                    return Err("Invalid TCP candidate count".into());
                }
                for candidate in candidates {
                    candidate.validate()?;
                }
            }
            Self::Start { at_ms } if at_ms.abs_diff(now_ms()) > 15_000 => {
                return Err("Stale TCP start coordination; check device clocks".into());
            }
            _ => {}
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payload {
    pub version: u8,
    pub sender: PublicKey,
    pub recipient: PublicKey,
    pub nostr: nostr::key::PublicKey,
    pub session: String,
    pub attempt: u8,
    pub issued: u64,
    pub expires: u64,
    pub nonce: String,
    pub message: Message,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedPayload {
    payload: Payload,
    signature: String,
}

/// Fixed bound, fail closed under saturation. Monotonic session state separately prevents
/// a new nonce from resurrecting a completed attempt. Entries never depend on relay storage.
#[derive(Default)]
pub struct Replay {
    seen: HashMap<(PublicKey, String), u64>,
}
impl Replay {
    fn accept(&mut self, payload: &Payload, at: u64) -> Result<()> {
        self.seen.retain(|_, expires| *expires >= at);
        let key = (payload.sender, payload.nonce.clone());
        if self.seen.contains_key(&key) {
            return Err("Duplicate signaling message".into());
        }
        if self.seen.len() >= 4096 {
            return Err("Signaling replay cache full".into());
        }
        self.seen.insert(key, payload.expires);
        Ok(())
    }
}

pub struct Signaling {
    client: Client,
    identity: Identity,
    keys: Keys,
    reconnect: Vec<tokio_util::task::AbortOnDropHandle<()>>,
}
impl Signaling {
    pub async fn open(identity: Identity, relays: &[String]) -> Result<Self> {
        if relays.is_empty() || relays.len() > 5 {
            return Err("Use one to five Nostr relays".into());
        }
        let mut limits = RelayLimits::default();
        limits.messages.max_size = Some(16 * 1024);
        limits.events.max_size = Some(12 * 1024);
        let client = Client::builder()
            .relay_limits(limits)
            .notification_channel_size(NonZeroUsize::new(128).unwrap())
            .connect_timeout(Duration::from_secs(6))
            .build();
        for url in relays {
            let parsed: url::Url = url.parse()?;
            if !url.starts_with("wss://") || parsed.port().is_some_and(|p| p != 443) {
                #[cfg(not(test))]
                return Err("Nostr signaling requires wss:// on TCP/443".into());
                #[cfg(test)]
                if !url.starts_with("ws://127.0.0.1:") {
                    return Err("Invalid test relay".into());
                }
            }
            client
                .add_relay(url)
                .opts(
                    RelayOptions::default()
                        .reconnect(false)
                        .notification_channel_size(128),
                )
                .await?;
        }
        let keys = identity.signaling_keys()?;
        client.connect().and_wait(Duration::from_secs(6)).await;
        let reconnect = client
            .relays()
            .await
            .into_values()
            .map(|relay| {
                tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
                    let mut delay = 1u64;
                    loop {
                        if relay.status() == RelayStatus::Shutdown {
                            return;
                        }
                        if relay.status() == RelayStatus::Connected {
                            delay = 1;
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            continue;
                        }
                        let mut random = [0; 1];
                        let _ = getrandom::fill(&mut random);
                        tokio::time::sleep(Duration::from_millis(
                            delay * 1000 + u64::from(random[0]) * 4,
                        ))
                        .await;
                        let _ = relay.try_connect().timeout(Duration::from_secs(6)).await;
                        delay = (delay * 2).min(60);
                    }
                }))
            })
            .collect();
        Ok(Self {
            client,
            identity,
            keys,
            reconnect,
        })
    }
    pub fn defaults() -> Vec<String> {
        RELAYS.iter().map(|s| (*s).into()).collect()
    }
    pub(crate) fn identity(&self) -> &Identity {
        &self.identity
    }
    pub fn public_key(&self) -> nostr::key::PublicKey {
        self.keys.public_key()
    }
    pub fn notifications(&self) -> Pin<Box<dyn Stream<Item = ClientNotification> + Send>> {
        self.client.notifications()
    }
    pub async fn subscribe(&self) -> Result<()> {
        self.client
            .subscribe(
                Filter::new()
                    .kind(SIGNAL_KIND)
                    .pubkey(self.public_key())
                    .since(Timestamp::from_secs(now().saturating_sub(SKEW)))
                    .limit(0),
            )
            .await?;
        Ok(())
    }
    async fn publish(&self, event: &Event) -> Result<()> {
        let relays = self.client.relays().await;
        let mut sends = futures_util::stream::FuturesUnordered::new();
        for relay in relays.values() {
            sends.push(async move {
                relay
                    .send_event(event)
                    .ok_timeout(Duration::from_secs(3))
                    .await
            });
        }
        let mut failures = Vec::new();
        // Every relay is polled concurrently. One acknowledged publication suffices;
        // dead relays must not delay a working control path by their whole timeout.
        while let Some(result) = sends.next().await {
            match result {
                Ok(_) => return Ok(()),
                Err(error) => failures.push(error.to_string()),
            }
        }
        Err(format!("Nostr publishing unavailable: {}", failures.join("; ")).into())
    }
    pub async fn announce(&self) -> Result<()> {
        let binding = Binding {
            version: 1,
            device: self.identity.public_key(),
            nostr: self.public_key(),
        };
        let signature = signature(&self.identity, &binding)?;
        let event = EventBuilder::new(
            BINDING_KIND,
            serde_json::to_string(&SignedBinding { binding, signature })?,
        )
        .tags([
            Tag::identifier(identifier(self.identity.public_key())),
            Tag::expiration(Timestamp::from_secs(now() + 24 * 3600)),
        ])
        .finalize(&self.keys)?;
        self.publish(&event).await
    }
    pub fn check_binding(event: &Event, expected: PublicKey) -> Result<Binding> {
        if event.kind != BINDING_KIND
            || event.content.len() > 2048
            || event.created_at.as_secs() > now() + SKEW
            || event.created_at.as_secs() + 24 * 3600 < now()
        {
            return Err("Invalid signaling binding event".into());
        }
        event.verify()?;
        let signed: SignedBinding = serde_json::from_str(&event.content)?;
        let b = signed.binding;
        if b.version != 1 || b.device != expected || b.nostr != event.pubkey {
            return Err("Signaling identity does not match paired device".into());
        }
        verify(b.device, &b, &signed.signature)?;
        Ok(b)
    }
    pub async fn discover(&self, expected: PublicKey) -> Result<Binding> {
        let events = self
            .client
            .fetch_events(
                Filter::new()
                    .kind(BINDING_KIND)
                    .identifier(identifier(expected))
                    .limit(8),
            )
            .timeout(Duration::from_secs(5))
            .max_events(24)
            .await?;
        events.iter().find_map(|event| Self::check_binding(event, expected).ok())
            .ok_or_else(|| "No verified Nostr binding for paired server; server must be online with TCP punching enabled".into())
    }
    pub fn event(
        &self,
        peer: &Binding,
        session: &str,
        attempt: u8,
        message: Message,
    ) -> Result<Event> {
        message.validate()?;
        let payload = Payload {
            version: 1,
            sender: self.identity.public_key(),
            recipient: peer.device,
            nostr: self.public_key(),
            session: session.into(),
            attempt,
            issued: now(),
            expires: now() + LIFETIME,
            nonce: nonce()?,
            message,
        };
        let issued = payload.issued;
        let signature = signature(&self.identity, &payload)?;
        let plaintext = serde_json::to_string(&SignedPayload { payload, signature })?;
        if plaintext.len() > 4096 {
            return Err("Signaling payload too large".into());
        }
        let content = nip44::encrypt(
            self.keys.secret_key(),
            &peer.nostr,
            plaintext,
            nip44::Version::V2,
        )?;
        Ok(EventBuilder::new(SIGNAL_KIND, content)
            .custom_created_at(Timestamp::from_secs(issued))
            .tags([
                Tag::public_key(peer.nostr),
                Tag::expiration(Timestamp::from_secs(now() + LIFETIME)),
            ])
            .finalize(&self.keys)?)
    }
    pub async fn send(
        &self,
        peer: &Binding,
        session: &str,
        attempt: u8,
        message: Message,
    ) -> Result<()> {
        let phase = message.phase();
        let event = self.event(peer, session, attempt, message)?;
        tracing::debug!(phase, "Publishing encrypted Nostr control");
        self.publish(&event).await
    }
    pub fn decode(
        &self,
        event: &Event,
        admit: &crate::gate::Admit,
        replay: &mut Replay,
    ) -> Result<Payload> {
        if event.kind != SIGNAL_KIND
            || event.content.len() > MAX_CONTENT
            || event.tags.len() > 4
            || event.created_at.as_secs() > now() + SKEW
            || event.created_at.as_secs() + LIFETIME < now()
            || !event.tags.public_keys().any(|p| p == self.public_key())
        {
            return Err("Invalid signaling event".into());
        }
        event.verify()?;
        let plaintext = zeroize::Zeroizing::new(nip44::decrypt(
            self.keys.secret_key(),
            &event.pubkey,
            &event.content,
        )?);
        if plaintext.len() > 4096 {
            return Err("Signaling plaintext too large".into());
        }
        let signed: SignedPayload = serde_json::from_str(&plaintext)?;
        let p = signed.payload;
        if p.version != 1
            || p.recipient != self.identity.public_key()
            || p.nostr != event.pubkey
            || p.attempt > 2
            || !valid_nonce(&p.session)
            || !valid_nonce(&p.nonce)
            || p.issued > now() + SKEW
            || p.expires < now()
            || p.expires < p.issued
            || p.expires - p.issued > LIFETIME
            || p.issued != event.created_at.as_secs()
            || !admit(&p.sender)
        {
            return Err("Unpaired, stale or misdirected signaling message".into());
        }
        verify(p.sender, &p, &signed.signature)?;
        p.message.validate()?;
        replay.accept(&p, now())?;
        tracing::debug!(
            phase = p.message.phase(),
            "Received authenticated Nostr control"
        );
        Ok(p)
    }
    pub async fn receive(
        &self,
        stream: &mut Pin<Box<dyn Stream<Item = ClientNotification> + Send>>,
        admit: &crate::gate::Admit,
        replay: &mut Replay,
    ) -> Result<Payload> {
        while let Some(notification) = stream.next().await {
            if let ClientNotification::Event { event, .. } = notification {
                if let Ok(payload) = self.decode(&event, admit, replay) {
                    return Ok(payload);
                }
            }
        }
        Err("Nostr signaling connection ended".into())
    }
    pub async fn shutdown(&self) {
        for task in &self.reconnect {
            task.abort();
        }
        self.client.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn offline(identity: Identity) -> Signaling {
        let keys = identity.signaling_keys().unwrap();
        Signaling {
            client: Client::new(),
            identity,
            keys,
            reconnect: Vec::new(),
        }
    }
    fn binding(s: &Signaling) -> Binding {
        Binding {
            version: 1,
            device: s.identity.public_key(),
            nostr: s.public_key(),
        }
    }
    fn admit(key: PublicKey) -> crate::gate::Admit {
        std::sync::Arc::new(move |k| *k == key)
    }
    fn rewrite(
        s: &Signaling,
        recipient: &Signaling,
        event: &Event,
        change: impl FnOnce(&mut SignedPayload),
    ) -> Event {
        let plaintext =
            nip44::decrypt(s.keys.secret_key(), &recipient.public_key(), &event.content).unwrap();
        let mut value: SignedPayload = serde_json::from_str(&plaintext).unwrap();
        change(&mut value);
        let issued = value.payload.issued;
        let content = nip44::encrypt(
            s.keys.secret_key(),
            &recipient.public_key(),
            serde_json::to_string(&value).unwrap(),
            nip44::Version::V2,
        )
        .unwrap();
        EventBuilder::new(SIGNAL_KIND, content)
            .custom_created_at(Timestamp::from_secs(issued))
            .tags([Tag::public_key(recipient.public_key())])
            .finalize(&s.keys)
            .unwrap()
    }
    #[test]
    fn stable_separate_keys_and_public_binding_require_both_signatures() {
        let identity = Identity::generate().unwrap();
        let a = offline(identity.clone());
        let b = offline(identity);
        assert_eq!(a.public_key(), b.public_key());
        assert_ne!(a.public_key().to_hex(), a.identity.public_key().to_string());
        let binding = binding(&a);
        let signed = SignedBinding {
            signature: signature(&a.identity, &binding).unwrap(),
            binding,
        };
        let event = EventBuilder::new(BINDING_KIND, serde_json::to_string(&signed).unwrap())
            .finalize(&a.keys)
            .unwrap();
        assert!(Signaling::check_binding(&event, a.identity.public_key()).is_ok());
        assert!(
            Signaling::check_binding(&event, Identity::generate().unwrap().public_key()).is_err()
        );
        let other = offline(Identity::generate().unwrap());
        let forged = EventBuilder::new(BINDING_KIND, event.content)
            .finalize(&other.keys)
            .unwrap();
        assert!(Signaling::check_binding(&forged, a.identity.public_key()).is_err());
    }
    #[test]
    fn encrypted_events_reject_strangers_wrong_recipient_duplicates_and_tampering() {
        let a = offline(Identity::generate().unwrap());
        let b = offline(Identity::generate().unwrap());
        let c = offline(Identity::generate().unwrap());
        let event = a
            .event(&binding(&b), &nonce().unwrap(), 0, Message::Ready {})
            .unwrap();
        assert!(!event.content.contains("sender"));
        assert!(
            !event
                .as_json()
                .contains(&a.identity.public_key().to_string())
        );
        let mut replay = Replay::default();
        assert!(
            b.decode(&event, &admit(c.identity.public_key()), &mut replay)
                .is_err()
        );
        assert!(
            c.decode(&event, &admit(a.identity.public_key()), &mut replay)
                .is_err()
        );
        let p = b
            .decode(&event, &admit(a.identity.public_key()), &mut replay)
            .unwrap();
        assert!(matches!(p.message, Message::Ready {}));
        assert!(
            b.decode(&event, &admit(a.identity.public_key()), &mut replay)
                .is_err()
        );
        let changed = rewrite(&a, &b, &event, |s| s.payload.message = Message::Failed {});
        assert!(
            b.decode(
                &changed,
                &admit(a.identity.public_key()),
                &mut Replay::default()
            )
            .is_err()
        );
        let forged = EventBuilder::new(SIGNAL_KIND, event.content.clone())
            .tags(event.tags.clone())
            .finalize(&c.keys)
            .unwrap();
        assert!(
            b.decode(
                &forged,
                &admit(a.identity.public_key()),
                &mut Replay::default()
            )
            .is_err()
        );
    }
    #[test]
    fn stale_future_oversized_and_invalid_sessions_fail_closed() {
        let a = offline(Identity::generate().unwrap());
        let b = offline(Identity::generate().unwrap());
        let event = a
            .event(&binding(&b), &nonce().unwrap(), 0, Message::Ready {})
            .unwrap();
        for change in [0, 1, 2, 3, 4, 5] {
            let bad = rewrite(&a, &b, &event, |s| {
                match change {
                    0 => s.payload.expires = now() - 1,
                    1 => s.payload.issued = now() + 60,
                    2 => s.payload.attempt = 3,
                    3 => s.payload.session = "bad".into(),
                    4 => s.payload.recipient = a.identity.public_key(),
                    _ => s.payload.expires = now() + 3600,
                }
                s.signature = signature(&a.identity, &s.payload).unwrap();
            });
            assert!(
                b.decode(
                    &bad,
                    &admit(a.identity.public_key()),
                    &mut Replay::default()
                )
                .is_err(),
                "case {change}"
            );
        }
        let huge = EventBuilder::new(SIGNAL_KIND, "x".repeat(MAX_CONTENT + 1))
            .finalize(&a.keys)
            .unwrap();
        assert!(
            b.decode(
                &huge,
                &admit(a.identity.public_key()),
                &mut Replay::default()
            )
            .is_err()
        );
        assert!(
            serde_json::from_str::<Message>(r#"{"type":"Ready","candidate":"hidden"}"#).is_err()
        );
        assert!(
            a.event(
                &binding(&b),
                &nonce().unwrap(),
                0,
                Message::Start {
                    at_ms: now_ms() - 60_000
                }
            )
            .is_err()
        );
    }
    #[test]
    fn small_clock_skew_is_accepted_but_expiration_is_always_local() {
        let a = offline(Identity::generate().unwrap());
        let b = offline(Identity::generate().unwrap());
        let event = a
            .event(&binding(&b), &nonce().unwrap(), 0, Message::Ready {})
            .unwrap();
        for future in [false, true] {
            let changed = rewrite(&a, &b, &event, |signed| {
                signed.payload.issued = if future { now() + 15 } else { now() - 15 };
                signed.payload.expires = signed.payload.issued + LIFETIME;
                signed.signature = signature(&a.identity, &signed.payload).unwrap();
            });
            assert!(
                b.decode(
                    &changed,
                    &admit(a.identity.public_key()),
                    &mut Replay::default()
                )
                .is_ok()
            );
        }
    }

    #[test]
    fn out_of_order_unique_messages_pass_but_replays_and_cache_saturation_fail() {
        let a = offline(Identity::generate().unwrap());
        let b = offline(Identity::generate().unwrap());
        let session = nonce().unwrap();
        let first = a
            .event(&binding(&b), &session, 0, Message::Ready {})
            .unwrap();
        let second = a
            .event(&binding(&b), &session, 0, Message::Connected {})
            .unwrap();
        let mut replay = Replay::default();
        // Delivery order is not relay trust. Session state, not this crypto layer,
        // decides whether a correctly signed phase is appropriate for an attempt.
        b.decode(&second, &admit(a.identity.public_key()), &mut replay)
            .unwrap();
        b.decode(&first, &admit(a.identity.public_key()), &mut replay)
            .unwrap();
        assert!(
            b.decode(&first, &admit(a.identity.public_key()), &mut replay)
                .is_err()
        );
        for i in 0..4096 {
            replay
                .seen
                .insert((a.identity.public_key(), format!("{i:032x}")), now() + 90);
        }
        let third = a
            .event(&binding(&b), &session, 0, Message::Failed {})
            .unwrap();
        assert!(
            b.decode(&third, &admit(a.identity.public_key()), &mut replay)
                .is_err()
        );
    }

    #[tokio::test]
    async fn relay_restart_reconnects_and_restores_subscription() {
        let relay = nostr_sdk::prelude::LocalRelay::builder().build();
        relay.run().await.unwrap();
        let url = relay.url().await.to_string();
        let port = url::Url::parse(&url).unwrap().port().unwrap();
        let a = Signaling::open(Identity::generate().unwrap(), &[url.clone()])
            .await
            .unwrap();
        let b = Signaling::open(Identity::generate().unwrap(), &[url])
            .await
            .unwrap();
        let mut events = b.notifications();
        b.subscribe().await.unwrap();
        relay.shutdown();
        tokio::time::timeout(Duration::from_secs(5), async {
            while a
                .client
                .relays()
                .await
                .values()
                .any(|r| r.status() == RelayStatus::Connected)
                || b.client
                    .relays()
                    .await
                    .values()
                    .any(|r| r.status() == RelayStatus::Connected)
            {
                // LocalRelay uses notify_waiters; a just-accepted session can miss
                // its first notification before its handler starts polling.
                relay.shutdown();
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let replacement = nostr_sdk::prelude::LocalRelay::builder().port(port).build();
        replacement.run().await.unwrap();
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if a.client.relays().await.values().all(|r| r.status() == RelayStatus::Connected)
                    && b.client.relays().await.values().all(|r| r.status() == RelayStatus::Connected) { break; }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let binding = binding(&b);
            let session = nonce().unwrap();
            let mut retry = tokio::time::interval(Duration::from_secs(2));
            let mut replay = Replay::default();
            let admit = admit(a.identity.public_key());
            loop {
                tokio::select! {
                    _ = retry.tick() => { a.send(&binding, &session, 0, Message::Ready {}).await.unwrap(); }
                    result = b.receive(&mut events, &admit, &mut replay) => { result.unwrap(); break; }
                }
            }
        }).await.unwrap();
        a.shutdown().await;
        b.shutdown().await;
        replacement.shutdown();
    }

    #[tokio::test]
    async fn local_relay_delivers_encrypted_events_and_survives_one_failed_relay() {
        let relay = nostr_sdk::prelude::LocalRelay::builder().build();
        relay.run().await.unwrap();
        let url = relay.url().await.to_string();
        let a = Signaling::open(
            Identity::generate().unwrap(),
            &[url.clone(), "ws://127.0.0.1:1".into()],
        )
        .await
        .unwrap();
        let b = Signaling::open(Identity::generate().unwrap(), &[url])
            .await
            .unwrap();
        let mut events = b.notifications();
        b.subscribe().await.unwrap();
        b.announce().await.unwrap();
        let discovered = a.discover(b.identity.public_key()).await.unwrap();
        assert_eq!(discovered.nostr, b.public_key());
        let session = nonce().unwrap();
        a.send(&discovered, &session, 0, Message::Ready {})
            .await
            .unwrap();
        let p = tokio::time::timeout(
            Duration::from_secs(5),
            b.receive(
                &mut events,
                &admit(a.identity.public_key()),
                &mut Replay::default(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(p.session, session);
        a.shutdown().await;
        b.shutdown().await;
        relay.shutdown();
    }
}
