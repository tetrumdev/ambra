//! Isolated public-DHT benchmark. Uses only the test server's fixture token.
//! Usage: connection_bench SERVER_KEY [rounds=10] [parallel=1]
use ambra_net::{Identity, PublicKey, hyperdht::Client, transport::HttpConnection};
use axum::body::Body;
use http_body_util::BodyExt;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let mut args = std::env::args().skip(1);
    let key = PublicKey::try_from(args.next().ok_or("Pass fixture server key")?)?;
    let rounds: usize = args
        .next()
        .map(|v| v.parse())
        .transpose()?
        .unwrap_or(10)
        .clamp(1, 30);
    let parallel: usize = args
        .next()
        .map(|v| v.parse())
        .transpose()?
        .unwrap_or(1)
        .clamp(1, 8);
    let lan = match args.next().as_deref() {
        None => None,
        Some("--lan") => Some(
            args.next()
                .ok_or("Pass LAN address")?
                .parse::<std::net::SocketAddr>()?,
        ),
        _ => return Err("Expected --lan ADDRESS".into()),
    };
    let mut tasks = tokio::task::JoinSet::new();
    for client in 0..parallel {
        tasks.spawn(async move {
            let identity = Identity::generate()?;
            let node = Arc::new(Client::new(identity.clone()));
            for round in 0..rounds {
                let start = Instant::now();
                let result = tokio::time::timeout(Duration::from_secs(45), async {
                    let (io, pump) = if let Some(address) = lan { ambra_net::lan::connect(address, key, &identity).await? } else { node.connect(key).await? };
                    let connection = HttpConnection::new(io, pump).await?;
                    let response = connection.request(hyper::Request::builder().uri("/api/test").header("authorization", "Bearer interop-fixture").body(Body::empty())?).await?;
                    if !response.status().is_success() { return Err("Fixture authorization failed".into()); }
                    let body = response.into_body().collect().await?.to_bytes();
                    assert_eq!(&body[..], b"ambra-server-interop");
                    let connected_ms = start.elapsed().as_secs_f64() * 1000.;
                    let stream_start = Instant::now();
                    let response = connection.request(hyper::Request::builder().uri("/api/stream").header("authorization", "Bearer interop-fixture").body(Body::empty())?).await?;
                    let bytes = response.into_body().collect().await?.to_bytes();
                    assert_eq!(bytes.len(), 2 * 1024 * 1024);
                    assert!(bytes.iter().all(|&b| b == 42));
                    let throughput_mib_s = 2. / stream_start.elapsed().as_secs_f64();
                    connection.close();
                    Ok::<_, ambra_net::Error>((connected_ms, throughput_mib_s))
                }).await;
                match result {
                    Ok(Ok((latency, throughput))) => println!("{}", serde_json::json!({"client":client,"round":round,"ok":true,"connection_ms":latency,"throughput_mib_s":throughput})),
                    result => println!("{}", serde_json::json!({"client":client,"round":round,"ok":false,"elapsed_ms":start.elapsed().as_secs_f64()*1000.,"error":format!("{result:?}")})),
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            node.shutdown().await;
            Ok::<_, ambra_net::Error>(())
        });
    }
    while let Some(result) = tasks.join_next().await {
        result??;
    }
    Ok(())
}
