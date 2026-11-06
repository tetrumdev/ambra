//! Exercises a server's router-forwarded public TCP path.
//!
//!   public_probe pair    <link> <dir>                 pair over the LAN; learn public endpoints
//!   public_probe remote  <link> <dir> [--device IF]   dial public endpoints (optionally out of IF)
//!   public_probe manager <link> <dir>                 full ConnectionManager with no LAN hints
use ambra_net::{
    ConnectionManager, Identity, SelectedServer, pairing::PairingPayload, transport::HttpConnection,
};
use axum::body::Body;
use http_body_util::BodyExt;
use hyper::Request;
use std::{net::SocketAddr, path::PathBuf, time::{Duration, Instant}};

#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .try_init();
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).ok_or("mode")?.as_str();
    let payload = PairingPayload::decode(args.get(2).ok_or("link")?)?;
    let dir = PathBuf::from(args.get(3).ok_or("dir")?);
    std::fs::create_dir_all(&dir)?;
    let identity = Identity::load_or_create(&dir.join("identity.key"))?;
    let cache = dir.join("endpoints.json");
    let selected = |local: bool| SelectedServer {
        public_key: payload.public_key,
        local_addresses: if local { payload.local_addresses.clone() } else { vec![] },
        public_endpoint: None,
        public_tcp: payload.public_tcp.clone(),
    };
    match mode {
        "pair" => {
            let manager = ConnectionManager::new(identity, selected(true), None);
            manager.use_endpoint_cache(cache);
            let started = manager
                .json("POST", "/api/pair/request", Some(serde_json::json!({ "clientId": "public-probe", "clientName": "Public probe" })))
                .await?;
            let id = started["requestId"].as_str().ok_or("no id")?.to_owned();
            println!("CODE {}", started["code"].as_str().unwrap_or_default());
            let token = loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let reply = manager.json("GET", &format!("/api/pair/request/{id}"), None).await?;
                match reply["status"].as_str() {
                    Some("approved") => break reply["token"].as_str().ok_or("no token")?.to_owned(),
                    Some("pending") | None => continue,
                    Some(other) => return Err(format!("pairing {other}").into()),
                }
            };
            manager.authorize(token.clone()).await?;
            std::fs::write(dir.join("token"), &token)?;
            println!("PAIRED; public endpoints {:?}", manager.public_endpoints());
            manager.shutdown().await;
        }
        "remote" => {
            let token = std::fs::read_to_string(dir.join("token"))?;
            let device = args.iter().position(|a| a == "--device").and_then(|i| args.get(i + 1)).cloned();
            let manager = ConnectionManager::new(identity.clone(), selected(false), None);
            manager.use_endpoint_cache(cache);
            let mut endpoints = manager.public_endpoints();
            let mut https: Vec<SocketAddr> = endpoints.iter().map(|a| SocketAddr::new(a.ip(), 443)).collect();
            https.retain(|a| !endpoints.contains(a));
            https.dedup();
            endpoints.extend(https);
            for endpoint in endpoints {
                let started = Instant::now();
                let result = tokio::time::timeout(Duration::from_secs(6), dial(endpoint, device.as_deref(), &identity, &payload)).await;
                let connection = match result {
                    Ok(Ok(connection)) => connection,
                    Ok(Err(error)) => { println!("{endpoint}: FAILED {error}"); continue; }
                    Err(_) => { println!("{endpoint}: FAILED timed out"); continue; }
                };
                let handshake = started.elapsed();
                let auth = connection.request(Request::get("/api/network/session").header("authorization", format!("Bearer {token}")).body(Body::empty())?).await?;
                let status = auth.status();
                let body = auth.into_body().collect().await?.to_bytes();
                let mut samples = Vec::new();
                for _ in 0..20 {
                    let t = Instant::now();
                    let response = connection.request(Request::get("/api/server/info").body(Body::empty())?).await?;
                    response.into_body().collect().await?;
                    samples.push(t.elapsed().as_secs_f64() * 1000.0);
                }
                samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
                println!(
                    "{endpoint}: connected+Noise {:.0} ms; session {status} {}; request RTT p50 {:.1} ms p95 {:.1} ms",
                    handshake.as_secs_f64() * 1000.0,
                    String::from_utf8_lossy(&body),
                    samples[10],
                    samples[18]
                );
                if let Some(path) = args.iter().position(|a| a == "--download").and_then(|i| args.get(i + 1)) {
                    let t = Instant::now();
                    let response = connection.request(Request::get(path.as_str()).header("authorization", format!("Bearer {token}")).body(Body::empty())?).await?;
                    let status = response.status();
                    let mut body = response.into_body();
                    let mut bytes = 0usize;
                    let mut first = None;
                    while let Some(frame) = body.frame().await {
                        if let Ok(data) = frame?.into_data() {
                            first.get_or_insert_with(|| t.elapsed());
                            bytes += data.len();
                        }
                    }
                    let seconds = t.elapsed().as_secs_f64();
                    println!(
                        "  download {status}: {bytes} bytes, first byte {:.0} ms, {:.1} Mbit/s",
                        first.unwrap_or_default().as_secs_f64() * 1000.0,
                        bytes as f64 * 8.0 / seconds / 1e6
                    );
                }
                connection.close();
            }
        }
        "manager" => {
            let token = std::fs::read_to_string(dir.join("token"))?;
            let manager = ConnectionManager::new(identity, selected(false), Some(token));
            manager.use_endpoint_cache(cache);
            let started = Instant::now();
            manager.connect().await?;
            println!("{:?} in {:.0} ms", manager.status(), started.elapsed().as_secs_f64() * 1000.0);
            manager.shutdown().await;
        }
        _ => return Err("unknown mode".into()),
    }
    Ok(())
}

async fn dial(
    endpoint: SocketAddr,
    device: Option<&str>,
    identity: &Identity,
    payload: &PairingPayload,
) -> ambra_net::Result<std::sync::Arc<HttpConnection>> {
    let socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::STREAM, Some(socket2::Protocol::TCP))?;
    #[cfg(target_os = "linux")]
    if let Some(device) = device {
        socket.bind_device(Some(device.as_bytes()))?;
    }
    let _ = device;
    socket.set_nonblocking(true)?;
    let socket = tokio::net::TcpSocket::from_std_stream(socket.into());
    let raw = socket.connect(endpoint).await?;
    raw.set_nodelay(true)?;
    let (io, _, pump) = ambra_net::transport::secure(raw, identity, Some(payload.public_key)).await?;
    HttpConnection::new(io, pump).await
}
