//! Publish only short-lived public capability markers; require both OK and independent delivery.
use futures_util::StreamExt;
use nostr_sdk::prelude::*;
use std::time::{Duration, Instant};
#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    let url = std::env::args().nth(1).ok_or("wss relay URL")?;
    let sender = Client::new();
    let receiver = Client::new();
    sender.add_relay(&url).await?;
    receiver.add_relay(&url).await?;
    sender.connect().and_wait(Duration::from_secs(6)).await;
    receiver.connect().and_wait(Duration::from_secs(6)).await;
    let keys = Keys::generate();
    let mut events = receiver.notifications();
    receiver
        .subscribe(
            Filter::new()
                .author(keys.public_key())
                .kinds([
                    Kind::Custom(30078),
                    Kind::Custom(38333),
                    Kind::Custom(10333),
                    Kind::Custom(28333),
                    Kind::Custom(20004),
                ])
                .limit(0),
        )
        .await?;
    for kind in [30078, 38333, 10333, 28333, 20004] {
        let event = EventBuilder::new(
            Kind::Custom(kind),
            "Ambra signaling capability check; contains no connection data",
        )
        .tags([
            Tag::identifier("ambra-capability-check"),
            Tag::expiration(Timestamp::now() + 90),
        ])
        .finalize(&keys)?;
        let start = Instant::now();
        let sent = sender
            .send_event(&event)
            .ok_timeout(Duration::from_secs(4))
            .await?;
        let received = tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(notification) = events.next().await {
                if let ClientNotification::Event {
                    event: incoming, ..
                } = notification
                {
                    if incoming.id == event.id {
                        return true;
                    }
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        println!(
            "{}",
            serde_json::json!({"relay":url,"kind":kind,"ack":!sent.success.is_empty(),"received":received,"elapsed_ms":start.elapsed().as_secs_f64()*1000.,"errors":format!("{:?}",sent.failed)})
        );
    }
    sender.shutdown().await;
    receiver.shutdown().await;
    Ok(())
}
