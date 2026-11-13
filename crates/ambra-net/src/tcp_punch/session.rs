//! Bounded offer/answer/ready/start coordination and the server's socket/session lifecycle.
use super::*;
use crate::signaling::{Binding, Message, Payload, Replay, Signaling, nonce, now, now_ms};
use std::collections::HashMap;
use tokio::sync::mpsc;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub error: Option<String>,
}
pub type SharedStatus = Arc<std::sync::RwLock<Status>>;

type Secure = (
    tokio::io::DuplexStream,
    transport::RemotePeer,
    transport::Pump,
);
fn peer(payload: &Payload) -> Binding {
    Binding {
        version: 1,
        device: payload.sender,
        nostr: payload.nostr,
    }
}
async fn start_at(at_ms: u64) -> Result<()> {
    if at_ms.abs_diff(now_ms()) > 15_000 {
        return Err("TCP coordination clock skew exceeds 15 seconds".into());
    }
    tokio::time::sleep(Duration::from_millis(at_ms.saturating_sub(now_ms()))).await;
    Ok(())
}

pub async fn connect(
    identity: Identity,
    server: PublicKey,
    cancel: CancellationToken,
) -> Result<(tokio::io::DuplexStream, transport::Pump)> {
    connect_with(
        identity,
        server,
        Config::default(),
        Signaling::defaults(),
        cancel,
    )
    .await
}
/// Also used by headless diagnostics. No other transport can satisfy this operation.
pub async fn connect_with(
    identity: Identity,
    server: PublicKey,
    config: Config,
    relays: Vec<String>,
    cancel: CancellationToken,
) -> Result<(tokio::io::DuplexStream, transport::Pump)> {
    let operation = async {
        let started = std::time::Instant::now();
        let signaling = Signaling::open(identity.clone(), &relays).await?;
        let mut events = signaling.notifications();
        signaling.subscribe().await?;
        let binding = signaling.discover(server).await?;
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis(),
            "Verified Nostr signaling ready"
        );
        let endpoint = Endpoint::gather(config).await?;
        let session = nonce()?;
        let admit: crate::gate::Admit = Arc::new(move |key| *key == server);
        let mut replay = Replay::default();
        let mut retry = tokio::time::interval(Duration::from_secs(3));
        retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let deadline = tokio::time::sleep(Duration::from_secs(18));
        tokio::pin!(deadline);
        let remote = loop {
            tokio::select! {
                _ = &mut deadline => return Err("Nostr candidate exchange timed out; no authenticated answer".into()),
                _ = retry.tick() => signaling.send(&binding, &session, 0, Message::Offer { candidates: endpoint.candidates.clone() }).await?,
                received = signaling.receive(&mut events, &admit, &mut replay) => {
                    let p = received?;
                    if p.session != session || p.attempt != 0 || p.nostr != binding.nostr { continue; }
                    match p.message {
                        Message::Answer { candidates } => break candidates,
                        Message::Failed {} => return Err("Server could not gather a native TCP candidate".into()),
                        _ => {}
                    }
                }
            }
        };
        let deadline = tokio::time::sleep(Duration::from_secs(12));
        tokio::pin!(deadline);
        retry.reset_immediately();
        let at = loop {
            tokio::select! {
                _ = &mut deadline => return Err("Nostr TCP start coordination timed out".into()),
                _ = retry.tick() => signaling.send(&binding, &session, 0, Message::Ready {}).await?,
                received = signaling.receive(&mut events, &admit, &mut replay) => {
                    let p = received?;
                    if p.session != session || p.attempt != 0 || p.nostr != binding.nostr { continue; }
                    match p.message { Message::Start { at_ms } => break at_ms, Message::Failed {} => return Err("Server TCP attempt failed".into()), _ => {} }
                }
            }
        };
        start_at(at).await?;
        let punch = endpoint.punch(&remote, &cancel, |raw| {
            secure_client(raw, identity.clone(), server)
        });
        tokio::pin!(punch);
        let (mut io, pump) = loop {
            tokio::select! {
                result = &mut punch => break result?,
                _ = retry.tick() => { let _ = signaling.send(&binding, &session, 0, Message::Ready {}).await; }
            }
        };
        tokio::time::timeout(Duration::from_secs(4), nominate(&mut io)).await??;
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis(),
            "Nostr coordinated native TCP peer authenticated; application data is direct"
        );
        let _ = signaling
            .send(&binding, &session, 0, Message::Connected {})
            .await;
        signaling.shutdown().await;
        Ok((io, pump))
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("TCP punching cancelled".into()),
        result = tokio::time::timeout(Duration::from_secs(65), operation) => result?,
    }
}

async fn answer(
    signaling: Arc<Signaling>,
    config: Config,
    offer: Payload,
    mut inbox: mpsc::Receiver<Payload>,
    admit: crate::gate::Admit,
    replay: Arc<crate::gate::Replay>,
    cancel: CancellationToken,
) -> Result<Secure> {
    let binding = peer(&offer);
    let Message::Offer { candidates: remote } = offer.message else {
        return Err("Expected TCP offer".into());
    };
    let operation = async {
        if !admit(&offer.sender) {
            return Err("Device revoked before candidate gathering".into());
        }
        let endpoint = Endpoint::gather(config).await?;
        let mut retry = tokio::time::interval(Duration::from_secs(3));
        retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let deadline = tokio::time::sleep(Duration::from_secs(15));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => return Err("Client did not confirm TCP readiness".into()),
                _ = retry.tick() => signaling.send(&binding, &offer.session, offer.attempt, Message::Answer { candidates: endpoint.candidates.clone() }).await?,
                p = inbox.recv() => {
                    let p = p.ok_or("TCP attempt inbox closed")?;
                    if matches!(p.message, Message::Ready {}) { break; }
                }
            }
        }
        let at_ms = now_ms() + 1200;
        signaling
            .send(
                &binding,
                &offer.session,
                offer.attempt,
                Message::Start { at_ms },
            )
            .await?;
        start_at(at_ms).await?;
        let identity = signaling.identity().clone();
        let expected = offer.sender;
        let punch = endpoint.punch(&remote, &cancel, |raw| {
            secure_server(
                raw,
                identity.clone(),
                expected,
                admit.clone(),
                replay.clone(),
            )
        });
        tokio::pin!(punch);
        loop {
            tokio::select! {
                result = &mut punch => return result,
                _ = retry.tick(), if now_ms() < at_ms + 8_000 => {
                    let _ = signaling.send(&binding, &offer.session, offer.attempt, Message::Start { at_ms }).await;
                }
            }
        }
    };
    let result = tokio::select! {
        _ = cancel.cancelled() => Err("TCP server attempt cancelled".into()),
        result = tokio::time::timeout(Duration::from_secs(55), operation) => result.map_err(Into::into).and_then(|r| r),
    };
    if result.is_err() && !cancel.is_cancelled() {
        let _ = signaling
            .send(&binding, &offer.session, offer.attempt, Message::Failed {})
            .await;
    }
    result
}

struct Attempt {
    inbox: mpsc::Sender<Payload>,
    expires: u64,
    nostr: nostr::key::PublicKey,
}
/// One persistent relay pool, at most eight attempts, one attempt per device, and 64
/// recent session tombstones. Only paired devices can allocate sockets or reach HTTP.
pub async fn serve(
    identity: Identity,
    app: axum::Router,
    admit: crate::gate::Admit,
    config: Config,
    relays: Vec<String>,
    status: SharedStatus,
    cancel: CancellationToken,
) -> Result<()> {
    let signaling = Arc::new(Signaling::open(identity, &relays).await?);
    let mut events = signaling.notifications();
    signaling.subscribe().await?;
    signaling.announce().await?;
    *status.write().unwrap_or_else(|p| p.into_inner()) = Status {
        running: true,
        error: None,
    };
    let mut refresh = tokio::time::interval(Duration::from_secs(6 * 3600));
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    refresh.tick().await;
    let mut attempts = JoinSet::new();
    let mut connections = JoinSet::new();
    let mut pending: HashMap<(PublicKey, String, u8), Attempt> = HashMap::new();
    let mut busy = std::collections::HashSet::new();
    let mut replay = Replay::default();
    let knock_replay = Arc::new(crate::gate::Replay::default());
    let outcome = loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break Ok(()),
            Some((key, result)) = async { attempts.join_next().await.and_then(|v: std::result::Result<(PublicKey, Result<Secure>), _>| v.ok()) }, if !attempts.is_empty() => {
                busy.remove(&key);
                match result {
                    Ok((io, peer, pump)) if admit(&key) => {
                        status.write().unwrap_or_else(|p| p.into_inner()).error = None;
                        connections.spawn(transport::serve(io, pump, peer, app.clone(), cancel.clone()));
                    }
                    Ok(_) => {}
                    Err(error) => {
                        tracing::debug!(%error, "Nostr TCP attempt failed");
                        status.write().unwrap_or_else(|p| p.into_inner()).error = Some(error.to_string());
                    }
                }
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            _ = refresh.tick() => {
                if let Err(error) = signaling.announce().await { status.write().unwrap_or_else(|p| p.into_inner()).error = Some(error.to_string()); }
            }
            received = signaling.receive(&mut events, &admit, &mut replay) => {
                let p = match received { Ok(p) => p, Err(e) => break Err(e) };
                pending.retain(|_, a| a.expires >= now());
                let key = (p.sender, p.session.clone(), p.attempt);
                if let Some(attempt) = pending.get(&key) {
                    // Never accept a different Nostr author halfway through a session.
                    if attempt.nostr == p.nostr { let _ = attempt.inbox.try_send(p); }
                } else if matches!(p.message, Message::Offer { .. }) && pending.len() < 64 && busy.len() < if config.port == 0 { 8 } else { 1 }
                    && connections.len() < 64 && !busy.contains(&p.sender) {
                    let (tx, rx) = mpsc::channel(8);
                    pending.insert(key, Attempt { inbox: tx, expires: p.expires + 30, nostr: p.nostr });
                    busy.insert(p.sender);
                    let s = signaling.clone(); let config = config.clone(); let admit = admit.clone();
                    let replay = knock_replay.clone(); let cancel = cancel.clone();
                    attempts.spawn(async move { (p.sender, answer(s, config, p, rx, admit, replay, cancel).await) });
                }
            }
        }
    };
    attempts.shutdown().await;
    connections.shutdown().await;
    signaling.shutdown().await;
    status.write().unwrap_or_else(|p| p.into_inner()).running = false;
    outcome
}
