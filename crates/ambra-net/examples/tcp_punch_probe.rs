//! Real-server native TCP acceptance probe, with no fallback transport in run mode.
//! enroll DIR SERVER_KEY ENROLL_ADDRESS: normal owner-approved pairing, save private token.
//! run DIR SERVER_KEY [ROUNDS]: authenticated API, concurrency, audio bytes/ranges, reconnect.
use ambra_net::{
    ConnectionManager, Identity, SelectedServer,
    manager::{Method, Timing},
};
use axum::body::Body;
use http_body_util::BodyExt;
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::Path,
    time::{Duration, Instant},
};
fn metric(value: serde_json::Value) {
    println!("{value}");
    let _ = std::io::stdout().flush();
}
fn private_write(path: &Path, bytes: &[u8]) -> ambra_net::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_ansi(false)
        .with_writer(std::io::stderr)
        .init();
    let args: Vec<_> = std::env::args().collect();
    let mode = args.get(1).ok_or("enroll or run")?;
    let directory = Path::new(args.get(2).ok_or("private profile directory")?);
    let server = ambra_net::PublicKey::try_from(args.get(3).ok_or("server key")?.clone())?;
    std::fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let identity = Identity::load_or_create(&directory.join("identity.key"))?;
    let token_path = directory.join("token");
    let selected = SelectedServer {
        public_key: server,
        local_addresses: if mode == "enroll" {
            vec![args.get(4).ok_or("enrollment address")?.parse()?]
        } else {
            vec![]
        },
        public_endpoint: None,
        public_tcp: vec![],
    };
    if mode == "enroll" {
        let manager = ConnectionManager::new(identity, selected, None);
        let requested=manager.json("POST","/api/pair/request",Some(serde_json::json!({"clientId":"nostr-tcp-physical-20261113","clientName":"Nostr native TCP acceptance probe"}))).await?;
        metric(serde_json::json!({"pairingCode":requested["code"]}));
        let handle = requested["requestId"].as_str().ok_or("pairing handle")?;
        let token = tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                let reply = manager
                    .json("GET", &format!("/api/pair/request/{handle}"), None)
                    .await?;
                if let Some(token) = reply["token"].as_str() {
                    break Ok::<_, ambra_net::Error>(token.to_owned());
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        })
        .await??;
        manager.authorize(token.clone()).await?;
        private_write(&token_path, token.as_bytes())?;
        metric(serde_json::json!({"paired":true}));
        manager.shutdown().await;
        return Ok(());
    }
    if !["run", "tailcat", "roam"].contains(&mode.as_str()) {
        return Err("Expected enroll, run, or tailcat".into());
    }
    let rounds: usize = args
        .get(4)
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(5)
        .clamp(1, 20);
    let token = std::fs::read_to_string(token_path)?;
    let manager = ConnectionManager::with_timing(
        identity,
        selected,
        Some(token),
        Timing {
            lan: Duration::ZERO,
            public: Duration::ZERO,
            hyperdht: Duration::ZERO,
            pwnat: Duration::ZERO,
            lan_grace: Duration::ZERO,
            tcp_punch: if mode != "run" {
                Duration::ZERO
            } else {
                Timing::default().tcp_punch
            },
            ..Default::default()
        },
    );
    manager.use_endpoint_cache(directory.join("endpoints.json"));
    // A real WAV container, synthetic silence. This verifies audio-file delivery, not audible playback.
    let size = 8 * 1024 * 1024usize;
    let mut audio = vec![0; size];
    audio[..4].copy_from_slice(b"RIFF");
    audio[4..8].copy_from_slice(&((size - 8) as u32).to_le_bytes());
    audio[8..16].copy_from_slice(b"WAVEfmt ");
    audio[16..20].copy_from_slice(&16u32.to_le_bytes());
    audio[20..22].copy_from_slice(&1u16.to_le_bytes());
    audio[22..24].copy_from_slice(&1u16.to_le_bytes());
    audio[24..28].copy_from_slice(&44100u32.to_le_bytes());
    audio[28..32].copy_from_slice(&88200u32.to_le_bytes());
    audio[32..34].copy_from_slice(&2u16.to_le_bytes());
    audio[34..36].copy_from_slice(&16u16.to_le_bytes());
    audio[36..40].copy_from_slice(b"data");
    audio[40..44].copy_from_slice(&((size - 44) as u32).to_le_bytes());
    let extension = if let Ok(file) = std::env::var("AMBRA_BENCH_AUDIO") {
        audio = std::fs::read(file)?;
        if audio.starts_with(b"fLaC") {
            "flac"
        } else if audio.starts_with(b"RIFF") {
            "wav"
        } else {
            return Err("Benchmark needs FLAC or WAV".into());
        }
    } else {
        "wav"
    };
    let path = format!(
        "/api/music/local/files/{:x}.{extension}",
        Sha256::digest(&audio)
    );
    let mut passed = 0;
    let mut maintenance = None;
    for round in 0..rounds {
        let started = Instant::now();
        let mut active = None;
        let result = async {
            manager.network_changed();
            active = Some(manager.connect().await?);
            let expected = if mode != "run" {Method::Tailcat} else {Method::TcpPunch};
            if manager.status().method != Some(expected) { return Err("Unexpected transport; test rejected".into()); }
            if let Some(ambra_net::tailcat::PeerPath::Direct {endpoint}) = manager.status().tailcat_path {
                if ambra_net::lan::is_direct(endpoint.ip()) { return Err("Tailcat benchmark rejected non-public direct endpoint".into()); }
                let route = std::process::Command::new("route").args(["-n", "get", &endpoint.ip().to_string()]).output()?;
                let route = String::from_utf8_lossy(&route.stdout);
                if !route.contains("interface: en0") { return Err("Tailcat direct path does not use school Wi-Fi".into()); }
            }
            metric(serde_json::json!({"stage":"authenticated","round":round,"connection_ms":started.elapsed().as_secs_f64()*1000.,"method":manager.status().method,"tailcat_path":manager.status().tailcat_path,"tailcat_rtt_ms":manager.status().tailcat_rtt_ms}));
            if mode == "roam" && maintenance.is_none() {
                let manager = manager.clone();
                maintenance = Some(tokio::spawn(async move {manager.run().await}));
            }
            let idle: u64 = std::env::var("AMBRA_BENCH_IDLE_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(0).min(60);
            for second in 0..idle {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if second % 15 == 0 || second + 1 == idle {
                    metric(serde_json::json!({"stage":"path", "seconds_after_authentication":second+1, "tailcat_path":manager.status().tailcat_path,"tailcat_rtt_ms":manager.status().tailcat_rtt_ms}));
                }
            }
            if let Some(ambra_net::tailcat::PeerPath::Direct {endpoint}) = manager.status().tailcat_path {
                if ambra_net::lan::is_direct(endpoint.ip()) { return Err("Tailcat benchmark rejected non-public direct endpoint".into()); }
            }
            let api = Instant::now();
            manager.json("GET", "/api/session", None).await?;
            metric(serde_json::json!({"stage":"api","round":round,"latency_ms":api.elapsed().as_secs_f64()*1000.}));
            if std::env::var_os("AMBRA_BENCH_REQUESTS_ONLY").is_some() { return Ok::<_, ambra_net::Error>(()); }
            if round == 0 {
                let response = manager.request(hyper::Request::builder().method("POST").uri(&path).body(Body::from(audio.clone()))?).await?;
                if !response.status().is_success() { return Err(format!("Audio upload: {}", response.status()).into()); }
                response.into_body().collect().await?;
            }
            let started = Instant::now();
            let mut bytes = 0usize;
            let mut requests = 0;
            let mut latencies = Vec::new();
            while started.elapsed() < Duration::from_secs(if mode != "run" {1} else {15}) {
                let finished = std::sync::atomic::AtomicBool::new(false);
                let download = async {
                    let response = manager.request(hyper::Request::builder().uri(&path).body(Body::empty())?).await?;
                    if !response.status().is_success() { return Err("Audio download failed".into()); }
                    let mut body = response.into_body();
                    let mut offset = 0;
                    while let Some(frame) = body.frame().await {
                        if let Ok(data) = frame?.into_data() {
                            if audio.get(offset..offset+data.len()) != Some(data.as_ref()) { return Err("Audio bytes differ".into()); }
                            offset += data.len();
                        }
                    }
                    if offset != audio.len() { return Err("Audio truncated".into()); }
                    finished.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok::<_, ambra_net::Error>(offset)
                };
                let controls = async {
                    let mut samples = Vec::new();
                    loop {
                        let api = Instant::now();
                        manager.json("GET", "/api/session", None).await?;
                        samples.push(api.elapsed().as_secs_f64()*1000.);
                        if finished.load(std::sync::atomic::Ordering::SeqCst) || samples.len() >= 100 { break; }
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    Ok::<_, ambra_net::Error>(samples)
                };
                let range = async {
                    let response = manager.request(hyper::Request::builder().uri(&path).header("range", "bytes=100-199").body(Body::empty())?).await?;
                    if response.status() != 206 || response.into_body().collect().await?.to_bytes().as_ref() != &audio[100..200] { return Err("Audio range mismatch".into()); }
                    Ok::<_, ambra_net::Error>(())
                };
                let (download, controls, range) = tokio::join!(download, controls, range);
                range?;
                bytes += download?;
                let samples = controls?;
                requests += samples.len() + 2;
                latencies.extend(samples);
            }
            metric(serde_json::json!({"stage":"transfer","round":round,"bytes":bytes,"seconds":started.elapsed().as_secs_f64(),"mib_per_second":bytes as f64/1048576./started.elapsed().as_secs_f64(),"concurrent_requests":requests,"api_latency_under_load_ms":latencies,"exact_audio":true,"tailcat_path_after_load":manager.status().tailcat_path}));
            let middle = audio.len() / 2;
            for (range, expected) in [(format!("bytes={}-{}", middle, middle+511), &audio[middle..middle+512]), ("bytes=-1024".to_owned(), &audio[audio.len()-1024..])] {
                let response = manager.request(hyper::Request::builder().uri(&path).header("range", range).body(Body::empty())?).await?;
                if response.status() != 206 || response.into_body().collect().await?.to_bytes().as_ref() != expected { return Err("Middle or suffix seek bytes differ".into()); }
            }
            metric(serde_json::json!({"stage":"seek", "round":round, "middle_bytes":512, "suffix_bytes":1024, "exact_audio":true}));
            if mode == "roam" {
                let started = Instant::now();
                // Keep an actual response on Tailcat while maintenance authenticates TCP.
                // Consumption is deliberately paced; this is a drain test, not a relay throughput test.
                let response = manager.request(hyper::Request::builder().uri(&path).body(Body::empty())?).await?;
                let mut body = response.into_body();
                let mut offset = 0;
                while let Some(frame) = body.frame().await {
                    if let Ok(data) = frame?.into_data() {
                        if audio.get(offset..offset+data.len()) != Some(data.as_ref()) { return Err("In-flight audio changed during native upgrade".into()); }
                        offset += data.len();
                        tokio::time::sleep(Duration::from_secs_f64(data.len() as f64 / (128. * 1024.))).await;
                    }
                }
                if offset != audio.len() { return Err("In-flight audio truncated during native upgrade".into()); }
                tokio::time::timeout(Duration::from_secs(60), async {
                    while manager.status().method == Some(Method::Tailcat) || manager.status().state == ambra_net::ConnectionState::Authenticating {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }).await?;
                manager.json("GET", "/api/session", None).await?;
                metric(serde_json::json!({"stage":"upgrade", "method":manager.status().method,"elapsed_ms":started.elapsed().as_secs_f64()*1000.,"in_flight_audio_bytes":offset,"in_flight_audio_preserved":true,"paced_bytes_per_second":128*1024}));
            }
            Ok::<_, ambra_net::Error>(())
        }.await;
        match result {
            Ok(()) => {
                passed += 1;
            }
            Err(error) => metric(
                serde_json::json!({"stage":"failure","round":round,"error":error.to_string(),"seconds":started.elapsed().as_secs_f64()}),
            ),
        }
        if let Some(connection) = active {
            connection.close();
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    manager.shutdown().await;
    if let Some(maintenance) = maintenance {
        let _ = maintenance.await;
    }
    metric(serde_json::json!({"passed":passed,"rounds":rounds,"hardware_playback":false}));
    if passed == 0 {
        return Err("No benchmark round passed".into());
    }
    Ok(())
}
