//! Isolated server integration probe, used by scripts/test-native-network.py.
use ambra_net::{ConnectionManager, Identity, SelectedServer, pairing::PairingPayload};
use std::{io::Write, time::Duration};
#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    let test_start = std::time::Instant::now();
    let _ = tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into())).with_writer(std::io::stderr).with_ansi(false).try_init();
    let args: Vec<String> = std::env::args().collect();
    let payload = PairingPayload::decode(args.get(1).ok_or("Pass pairing link")?)?;
    let desktop_data = args.iter().position(|a| a == "--desktop-data")
        .map(|i| args.get(i + 1).map(std::path::PathBuf::from).ok_or("Missing desktop data directory")).transpose()?;
    let file_id = args.get(2).ok_or("Pass audio SHA-256 filename")?;
    let client_id = args.iter().position(|a| a == "--client-id").and_then(|i| args.get(i + 1)).map_or("native-integration", String::as_str);
    if args.iter().any(|argument| argument == "--discover") {
        let servers = ambra_net::lan::discover(Duration::from_secs(2)).await?;
        assert!(servers.iter().any(|server| server.info.public_key == Some(payload.public_key)), "Independent server did not answer native discovery");
    }
    let identity = if let Some(directory) = &desktop_data {
        if directory.join("server-link.json").exists() { return Err("Refusing to overwrite desktop pairing settings".into()); }
        Identity::load_or_create(&directory.join("client-network-identity.key"))?
    } else { Identity::generate()? };
    let selected = SelectedServer {
        public_key: payload.public_key,
        local_addresses: payload.local_addresses.clone(),
        public_endpoint: payload.public_endpoint,
    };
    let pwnat_only = args.iter().any(|a| a == "--pwnat-only");
    let hyperdht_only = args.iter().any(|a| a == "--hyperdht-only");
    if pwnat_only && hyperdht_only { return Err("Select only one forced test transport".into()); }
    let enrollment = if pwnat_only {
        ConnectionManager::with_timing(identity.clone(), selected.clone(), None, ambra_net::manager::Timing {
            lan: Duration::ZERO, hyperdht: Duration::ZERO, ..Default::default()
        })
    } else if hyperdht_only {
        ConnectionManager::with_timing(identity.clone(), selected.clone(), None, ambra_net::manager::Timing {
            lan: Duration::ZERO, pwnat: Duration::ZERO, lan_grace: Duration::ZERO, ..Default::default()
        })
    } else { ConnectionManager::new(identity.clone(), selected.clone(), None) };
    let started = enrollment.json("POST", "/api/pair/request", Some(serde_json::json!({ "clientId": client_id, "clientName": "Native integration probe" }))).await?;
    println!("CODE {}", started["code"].as_str().ok_or("Missing code")?);
    std::io::stdout().flush()?;
    metric("pair_request", serde_json::json!({"elapsed_ms":test_start.elapsed().as_secs_f64()*1000.}));
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
    let auth_start = std::time::Instant::now();
    enrollment.authorize(token.clone()).await?;
    metric("authorization",serde_json::json!({"elapsed_ms":auth_start.elapsed().as_secs_f64()*1000.}));
    let replay = enrollment.json("GET", &format!("/api/pair/request/{handle}"), None).await?;
    assert_eq!(replay["status"], "expired");
    let manager = enrollment.clone();
    println!("TRANSPORT {}", serde_json::to_string(&manager.status())?);
    if pwnat_only { assert_eq!(manager.status().method, Some(ambra_net::manager::Method::Pwnat)); }
    if hyperdht_only { assert_eq!(manager.status().method, Some(ambra_net::manager::Method::HyperDHT)); }
    manager.json("GET", "/api/session", None).await?;
    let bridge = ambra_net::bridge::Bridge::start(manager.clone()).await?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(120)).build()?;
    let audio: Vec<u8> = if let Some(index) = args.iter().position(|a| a == "--audio-file") {
        std::fs::read(args.get(index + 1).ok_or("Missing audio fixture path")?)?
    } else {
        (0..=255).cycle().take(200_000).collect()
    };
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
    stream_audio(&client, &url, &audio).await?;
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
    if args.iter().any(|a| a == "--publish-fixture") {
        let duration: f64 = args.iter().position(|a|a=="--duration-seconds")
            .and_then(|i|args.get(i+1)).map(|s|s.parse()).transpose()?.unwrap_or(8.0);
        if !duration.is_finite() || duration<=0. || duration>3600. { return Err("Invalid fixture duration".into()); }
        let track = manager.json("POST", "/api/music/local/tracks", Some(serde_json::json!({
            "file": file_id, "name": "Native P2P test tone", "artist": "Ambra network test", "album": "Cross-network validation",
            "artists": [], "albumArtists": [], "durationSeconds": duration
        }))).await?;
        // Publishing library metadata does not put it in the session catalog.
        // Preserve the selection/history and add only this fixture, using the
        // server's revision guard rather than bypassing normal queue ownership.
        let session = manager.json("GET","/api/session",None).await?;
        let mut queue = session["queue"].clone();
        let tracks = queue["tracks"].as_array_mut().ok_or("Missing queue catalog")?;
        if !tracks.iter().any(|t|t["globalId"]==track["globalId"]) { tracks.push(track); }
        manager.json("POST","/api/session/queue",Some(serde_json::json!({"base":session["queueRevision"],"queue":queue}))).await?;
        println!("PUBLISHED Native P2P test tone");
    }
    if let Some(directory) = &desktop_data {
        let info = manager.json("GET", "/api/server/info", None).await?;
        let settings = serde_json::json!({ "mode": "join", "decided": true, "clientId": client_id, "token": token,
            "server": { "id": info["id"], "name": payload.name, "address": payload.public_key.to_string(), "publicKey": payload.public_key,
                "localAddresses": payload.local_addresses, "publicEndpoint": payload.public_endpoint } });
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(directory.join("server-link.json"))?;
        file.write_all(serde_json::to_string_pretty(&settings)?.as_bytes())?;
        file.sync_all()?;
        println!("SAVED isolated desktop pairing");
    }
    if args.iter().any(|a| a == "--control") {
        let (commands, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break; };
                if commands.send(line).is_err() { break; }
            }
        });
        println!("READY");
        std::io::stdout().flush()?;
        while let Some(command) = receiver.recv().await {
            match command.trim() {
                "status" => println!("STATUS {}", serde_json::to_string(&manager.status())?),
                "ping" => {
                    let start = std::time::Instant::now();
                    let result = manager.json("GET", "/api/session", None).await;
                    metric("session_request",serde_json::json!({"ok":result.is_ok(),"elapsed_ms":start.elapsed().as_secs_f64()*1000.}));
                    println!("PING {}", if result.is_ok() { "ok" } else { "failed" });
                    if let Err(error) = result { eprintln!("Session request failed: {error}"); }
                }
                "rebind" => {
                    manager.connect().await?.close();
                    println!("REBIND closed existing stream; reconnecting");
                }
                "stream" => match stream_audio(&client, &url, &audio).await {
                    Ok(()) => {}, Err(error) => println!("STREAM failed: {error}"),
                },
                "quit" => break,
                _ => println!("UNKNOWN command"),
            }
            std::io::stdout().flush()?;
        }
    }
    bridge.shutdown().await;
    manager.shutdown().await;
    Ok(())
}

async fn stream_audio(client: &reqwest::Client, url: &str, expected: &[u8]) -> ambra_net::Result<()> {
    use futures_util::StreamExt;
    let start = std::time::Instant::now();
    let response = client.get(url).send().await?.error_for_status()?;
    let mut stream = response.bytes_stream();
    let mut offset = 0;
    let mut chunks = 0;
    let mut first_byte_ms = None;
    let mut last = start;
    let mut max_gap_ms = 0f64;
    let mut gaps_over_250ms = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if !chunk.is_empty() {
            first_byte_ms.get_or_insert(start.elapsed().as_secs_f64()*1000.);
            if chunks > 0 {
                let gap = last.elapsed().as_secs_f64()*1000.;
                max_gap_ms = max_gap_ms.max(gap);
                gaps_over_250ms += usize::from(gap>250.);
            }
            last = std::time::Instant::now();
        }
        if expected.get(offset..offset + chunk.len()) != Some(chunk.as_ref()) {
            return Err("Streamed audio differs from uploaded fixture".into());
        }
        offset += chunk.len();
        chunks += 1;
    }
    if offset != expected.len() { return Err("Audio stream truncated".into()); }
    metric("audio_transfer",serde_json::json!({"bytes":offset,"elapsed_ms":start.elapsed().as_secs_f64()*1000.,
        "first_byte_ms":first_byte_ms,"throughput_mib_s":offset as f64/1048576./start.elapsed().as_secs_f64(),
        "max_body_gap_ms":max_gap_ms,"body_gaps_over_250ms":gaps_over_250ms,"exact_bytes":true,"hardware_playback":false}));
    println!("STREAM ok bytes={offset} chunks={chunks} elapsed_ms={}", start.elapsed().as_millis());
    Ok(())
}

fn metric(stage: &str, data: serde_json::Value) {
    println!("METRIC {}",serde_json::json!({"schema":1,"unix_ms":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),"stage":stage,"data":data}));
}
