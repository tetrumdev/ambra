//! Bounded fixture-only sustained encrypted HTTP/2 transfer with concurrent API polling.
//! Usage: streaming_bench SERVER_KEY [seconds=60]
use ambra_net::{Identity, PublicKey, hyperdht::Client, transport::HttpConnection};
use axum::body::Body;
use http_body_util::BodyExt;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

fn request(path: &str) -> hyper::Request<Body> {
    hyper::Request::builder()
        .uri(path)
        .header("authorization", "Bearer interop-fixture")
        .body(Body::empty())
        .unwrap()
}
#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let mut args = std::env::args().skip(1);
    let key = PublicKey::try_from(args.next().ok_or("Pass fixture server key")?)?;
    let seconds: u64 = args
        .next()
        .map(|v| v.parse())
        .transpose()?
        .unwrap_or(60)
        .clamp(1, 120);
    let node = Client::new(Identity::generate()?);
    let connection = tokio::time::timeout(Duration::from_secs(45), async {
        let (io, pump) = node.connect(key).await?;
        HttpConnection::new(io, pump).await
    })
    .await??;
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    let polling_connection = connection.clone();
    let mut polling = tokio::task::JoinSet::new();
    polling.spawn(async move {
        let mut timings = Vec::new();
        loop {
            let start = Instant::now();
            let operation = async {
                let response = polling_connection.request(request("/api/poll")).await?;
                if !response.status().is_success() { return Err("poll status".into()); }
                let bytes = response.into_body().collect().await?.to_bytes();
                if &bytes[..] != b"update" { return Err("poll body".into()); }
                Ok::<_, ambra_net::Error>(())
            };
            let result = tokio::select! {
                _ = stop.cancelled() => break,
                result = tokio::time::timeout(Duration::from_secs(10), operation) => result,
            };
            if !matches!(result,Ok(Ok(()))) {
                return Ok::<_,ambra_net::Error>((timings,Some(format!("{result:?}"))));
            }
            timings.push(start.elapsed().as_secs_f64() * 1000.);
            tokio::select! { _ = stop.cancelled() => break, _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
        }
        Ok::<_, ambra_net::Error>((timings,None))
    });
    let start = Instant::now();
    let mut bytes = 0u64;
    let mut responses = 0;
    let mut gaps_over_250ms = 0;
    let mut max_gap_ms = 0f64;
    let mut previous = Instant::now();
    let transfer = async {
        while start.elapsed() < Duration::from_secs(seconds) {
            let response = connection.request(request("/api/stream")).await?;
            if !response.status().is_success() {
                return Err("stream status".into());
            }
            let mut body = response.into_body();
            let mut response_bytes = 0;
            while let Some(frame) = body.frame().await {
                if let Ok(data) = frame?.into_data() {
                    if !data.iter().all(|&byte| byte == 42) {
                        return Err("stream integrity".into());
                    }
                    let gap = previous.elapsed().as_secs_f64() * 1000.;
                    previous = Instant::now();
                    max_gap_ms = max_gap_ms.max(gap);
                    gaps_over_250ms += u64::from(gap > 250.);
                    bytes += data.len() as u64;
                    response_bytes += data.len();
                }
            }
            if response_bytes != 2 * 1024 * 1024 {
                return Err("truncated stream".into());
            }
            responses += 1;
        }
        Ok::<_, ambra_net::Error>(())
    };
    let result = tokio::time::timeout(Duration::from_secs(seconds + 45), transfer).await;
    cancel.cancel();
    // Preserve transfer diagnostics even when concurrent control polling fails.
    // Returning early here previously discarded every byte/gap measurement.
    let (mut polls, poll_error) = match polling.join_next().await {
        Some(Ok(Ok((timings,error)))) => (timings,error),
        Some(Ok(Err(error))) => (Vec::new(),Some(error.to_string())),
        Some(Err(error)) => (Vec::new(),Some(error.to_string())),
        None => (Vec::new(),Some("poll task disappeared".to_owned())),
    };
    polls.sort_by(f64::total_cmp);
    let percentile = |p: f64| {
        polls
            .get(((polls.len() as f64 * p).ceil() as usize).saturating_sub(1))
            .copied()
    };
    println!(
        "{}",
        serde_json::json!({"seconds":start.elapsed().as_secs_f64(),"bytes":bytes,"responses":responses,
        "throughput_mib_s":bytes as f64/1048576./start.elapsed().as_secs_f64(),"polls":polls.len(),
        "poll_p50_ms":percentile(0.5),"poll_p95_ms":percentile(0.95),"max_body_gap_ms":max_gap_ms,
        "body_gaps_over_250ms":gaps_over_250ms,"result":format!("{result:?}"),"poll_error":poll_error})
    );
    connection.close();
    node.shutdown().await;
    result??;
    if let Some(error) = poll_error { return Err(error.into()); }
    Ok(())
}
