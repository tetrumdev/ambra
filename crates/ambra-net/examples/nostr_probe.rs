//! Bounded real-relay probe. Only public test identities cross the management channel.
//! Usage: nostr_probe identity DIR | listen DIR PEER_KEY RELAY | send DIR PEER_KEY RELAY
use ambra_net::{
    Identity, PublicKey,
    signaling::{Message, Replay, Signaling},
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<_> = std::env::args().collect();
    let mode = args.get(1).ok_or("mode")?;
    let directory = std::path::Path::new(args.get(2).ok_or("private directory")?);
    std::fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let identity = Identity::load_or_create(&directory.join("identity.key"))?;
    if mode == "identity" {
        println!("{}", identity.public_key());
        return Ok(());
    }
    let peer = PublicKey::try_from(args.get(3).ok_or("paired peer key")?.clone())?;
    let relay = args.get(4).ok_or("relay")?.clone();
    let started = Instant::now();
    let signaling = Signaling::open(identity, &[relay.clone()]).await?;
    let mut notifications = signaling.notifications();
    signaling.subscribe().await?;
    signaling.announce().await?;
    let relay_ms = started.elapsed().as_secs_f64() * 1000.;
    println!(
        "{}",
        serde_json::json!({"ready":true,"relay":relay,"relay_ms":relay_ms})
    );
    let admit: ambra_net::gate::Admit = Arc::new(move |key| *key == peer);
    let mut replay = Replay::default();
    let operation = async {
        if mode == "listen" {
            for _ in 0..3 {
                let p = signaling
                    .receive(&mut notifications, &admit, &mut replay)
                    .await?;
                let binding = ambra_net::signaling::Binding {
                    version: 1,
                    device: p.sender,
                    nostr: p.nostr,
                };
                signaling
                    .send(&binding, &p.session, p.attempt, Message::Ready {})
                    .await?;
                println!("{}", serde_json::json!({"received":true,"relay":relay}));
            }
        } else if mode == "send" {
            let binding = signaling.discover(peer).await?;
            for i in 0..3 {
                let session = format!("{:032x}", i + 1);
                let at = Instant::now();
                signaling
                    .send(&binding, &session, 0, Message::Ready {})
                    .await?;
                loop {
                    let p = signaling
                        .receive(&mut notifications, &admit, &mut replay)
                        .await?;
                    if p.session == session {
                        break;
                    }
                }
                println!(
                    "{}",
                    serde_json::json!({"round":i,"relay":relay,"signaling_roundtrip_ms":at.elapsed().as_secs_f64()*1000.})
                );
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        } else {
            return Err("Expected identity, listen or send".into());
        }
        Ok::<_, ambra_net::Error>(())
    };
    let result = tokio::time::timeout(Duration::from_secs(45), operation).await;
    signaling.shutdown().await;
    result??;
    Ok(())
}
