//! Isolated server integration probe, used by scripts/test-native-network.py.
use ambra_net::{ConnectionManager, Identity, SelectedServer, pairing::PairingPayload};
use std::{io::Write, time::Duration};
#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let payload = PairingPayload::decode(args.get(1).ok_or("Pass pairing link")?)?;
    let file_id = args.get(2).ok_or("Pass synthetic audio SHA-256 filename")?;
    if args.iter().any(|argument| argument == "--discover") {
        let servers = ambra_net::lan::discover(Duration::from_secs(2)).await?;
        assert!(servers.iter().any(|server| server.info.public_key == Some(payload.public_key)), "Independent server did not answer native discovery");
    }
    let identity = Identity::generate()?;
    let selected = SelectedServer {
        public_key: payload.public_key,
        local_addresses: payload.local_addresses,
        public_endpoint: payload.public_endpoint,
    };
    let enrollment = ConnectionManager::new(identity.clone(), selected.clone(), None);
    let started = enrollment.json("POST", "/api/pair/request", Some(serde_json::json!({ "clientId": "native-integration", "clientName": "Native integration probe" }))).await?;
    println!("CODE {}", started["code"].as_str().ok_or("Missing code")?);
    std::io::stdout().flush()?;
    let handle = started["requestId"].as_str().ok_or("Missing handle")?;
    if args.iter().any(|argument| argument == "--deny") {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let status = enrollment.json("GET", &format!("/api/pair/request/{handle}"), None).await?;
                if status["status"] == "denied" { break Ok::<_, ambra_net::Error>(()); }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }).await??;
        enrollment.cancel.cancel();
        println!("PASS server-owned pairing denial");
        return Ok(());
    }
    let token = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let status = enrollment
                .json("GET", &format!("/api/pair/request/{handle}"), None)
                .await?;
            if let Some(token) = status["token"].as_str() {
                break Ok::<_, ambra_net::Error>(token.to_owned());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await??;
    let manager = ConnectionManager::new(identity, selected, Some(token));
    manager.json("GET", "/api/session", None).await?;
    let bridge = ambra_net::bridge::Bridge::start(manager.clone()).await?;
    let client = reqwest::Client::new();
    let audio: Vec<u8> = (0..=255).cycle().take(200_000).collect();
    let url = format!("{}/api/music/local/files/{file_id}", bridge.base_url);
    assert!(
        client
            .post(&url)
            .body(audio.clone())
            .send()
            .await?
            .status()
            .is_success()
    );
    let response = client
        .get(&url)
        .header("range", "bytes=100-199")
        .send()
        .await?;
    assert_eq!(response.status(), 206);
    assert_eq!(response.bytes().await?.as_ref(), &audio[100..200]);
    assert_eq!(
        client
            .get(format!("{}/api/local/config", bridge.base_url))
            .send()
            .await?
            .status(),
        403
    );
    let replay = enrollment
        .json("GET", &format!("/api/pair/request/{handle}"), None)
        .await?;
    assert_eq!(replay["status"], "expired");
    println!(
        "PASS encrypted approval, session authorization, audio upload/range, enrollment replay rejection, local administration restriction"
    );
    manager.cancel.cancel();
    enrollment.cancel.cancel();
    drop(bridge);
    Ok(())
}
