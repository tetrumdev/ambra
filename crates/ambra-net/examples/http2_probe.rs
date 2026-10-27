use ambra_net::{Identity, PublicKey, hyperdht::Client, transport::HttpConnection};
use axum::body::Body;
use http_body_util::BodyExt;
#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    let key = PublicKey::try_from(std::env::args().nth(1).ok_or("Pass server public key")?)?;
    let node = Client::new(Identity::generate()?);
    let result = tokio::time::timeout(std::time::Duration::from_secs(45), async {
        let (io, pump) = node.connect(key).await?;
        let connection = HttpConnection::new(io, pump).await?;
        let response = connection
            .request(
                hyper::Request::builder()
                    .uri("/api/test")
                    .header("authorization", "Bearer interop-fixture")
                    .body(Body::empty())?,
            )
            .await?;
        let body = response.into_body().collect().await?.to_bytes();
        println!("HTTP2 {}", String::from_utf8_lossy(&body));
        let response = connection
            .request(
                hyper::Request::builder()
                    .uri("/api/stream")
                    .header("authorization", "Bearer interop-fixture")
                    .body(Body::empty())?,
            )
            .await?;
        let bytes = response.into_body().collect().await?.to_bytes();
        assert_eq!(bytes.len(), 2 * 1024 * 1024);
        println!("STREAM {} bytes", bytes.len());
        Ok::<_, ambra_net::Error>(())
    })
    .await;
    node.shutdown().await;
    result??;
    Ok(())
}
