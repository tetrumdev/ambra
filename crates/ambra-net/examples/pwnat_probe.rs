//! Opt-in diagnostics, not a server bundled with any client. Never requests elevation.
use ambra_net::{Identity, PublicKey, hyperdht, pwnat, transport};
use axum::body::Body;
use http_body_util::BodyExt;
use std::{net::SocketAddr, time::Duration};

#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ambra_net=info".into()),
        )
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("capability") => {
            println!("{}", serde_json::to_string(&pwnat::capability())?);
            #[cfg(unix)]
            println!("uid={} euid={}", unsafe { libc::getuid() }, unsafe {
                libc::geteuid()
            });
        }
        Some("lookup") => {
            let key = PublicKey::try_from(args.get(2).ok_or("Missing public key")?.clone())?;
            let client = hyperdht::Client::new(Identity::generate()?);
            let result =
                tokio::time::timeout(Duration::from_secs(20), client.pwnat_endpoint(key)).await;
            client.shutdown().await;
            println!("SIGNED_PWNAT_CANDIDATE {}", result??);
        }
        Some("connect") => {
            let endpoint: SocketAddr = args.get(2).ok_or("Missing public endpoint")?.parse()?;
            let key = PublicKey::try_from(args.get(3).ok_or("Missing pinned public key")?.clone())?;
            let (io, pump) = pwnat::connect(endpoint, key, &Identity::generate()?).await?;
            let connection = transport::HttpConnection::new(io, pump).await?;
            let response = tokio::time::timeout(
                Duration::from_secs(5),
                connection.request(
                    hyper::Request::builder()
                        .uri("/api/server/info")
                        .body(Body::empty())?,
                ),
            )
            .await??;
            let status = response.status();
            let bytes = http_body_util::Limited::new(response.into_body(), 65536)
                .collect()
                .await?
                .to_bytes();
            println!(
                "PWNAT_ONLY pinned_key={key} endpoint={endpoint} status={status} bytes={}",
                bytes.len()
            );
            connection.close();
            if !status.is_success() {
                return Err("pwnat HTTP server info failed".into());
            }
        }
        _ => return Err(
            "Usage: pwnat_probe capability | lookup PUBLIC_KEY | connect PUBLIC_IP:PORT PUBLIC_KEY"
                .into(),
        ),
    }
    Ok(())
}
