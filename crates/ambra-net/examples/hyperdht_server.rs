//! Temporary reference-test server; never an Ambra relay or production executable.
use ambra_net::{Identity, hyperdht};
use axum::{Router, body::Body, response::IntoResponse, routing::get};
use std::{
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let identity = Identity::generate()?;
    println!("KEY {}", identity.public_key());
    let app = Router::new()
        .route("/api/test", get(|| async { "ambra-server-interop" }))
        .route(
            "/api/stream",
            get(|| async { Body::from(vec![42; 2 * 1024 * 1024]) }),
        )
        .route(
            "/api/poll",
            get(|| async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                "update"
            }),
        )
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async {
                assert!(
                    request
                        .extensions()
                        .get::<ambra_net::transport::RemotePeer>()
                        .is_some()
                );
                if request
                    .headers()
                    .get("authorization")
                    .is_none_or(|h| h != "Bearer interop-fixture")
                {
                    return axum::http::StatusCode::UNAUTHORIZED.into_response();
                }
                next.run(request).await
            },
        ));
    let cancel = CancellationToken::new();
    let status = Arc::new(RwLock::new(hyperdht::Status::default()));
    let task = tokio::spawn(hyperdht::serve(
        identity,
        app,
        status.clone(),
        cancel.clone(),
        None,
    ));
    for _ in 0..120 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if status.read().unwrap().announced {
            println!("ANNOUNCED");
            break;
        }
    }
    tokio::select! { _ = tokio::time::sleep(Duration::from_secs(300)) => {}, _ = tokio::signal::ctrl_c() => {} }
    cancel.cancel();
    task.await??;
    Ok(())
}
