//! Live check of HyperDHT admission: a paired key connects, an unpaired key gets no reply.
use ambra_net::{Identity, hyperdht, transport::HttpConnection};
use axum::{Router, body::Body, routing::get};
use std::{sync::{Arc, RwLock}, time::{Duration, Instant}};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> ambra_net::Result<()> {
    let server = Identity::generate()?;
    let paired = Identity::generate()?;
    let stranger = Identity::generate()?;
    let paired_key = paired.public_key();
    let app = Router::new().route("/ok", get(|| async { "ok" }));
    let status = Arc::new(RwLock::new(hyperdht::Status::default()));
    let cancel = CancellationToken::new();
    let admit: ambra_net::gate::Admit = Arc::new(move |key| *key == paired_key);
    let task = tokio::spawn(hyperdht::serve(server.clone(), app, status.clone(), admit, cancel.clone(), None));
    while !status.read().unwrap().announced { tokio::time::sleep(Duration::from_millis(500)).await; }
    println!("announced {}", server.public_key());
    for (name, identity) in [("paired", paired), ("stranger", stranger)] {
        let client = hyperdht::Client::new(identity);
        let started = Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(25), async {
            let (io, pump) = client.connect(server.public_key()).await?;
            let connection = HttpConnection::new(io, pump).await?;
            let response = connection.request(hyper::Request::get("/ok").body(Body::empty())?).await?;
            Ok::<_, ambra_net::Error>(response.status())
        }).await;
        match result {
            Ok(Ok(code)) => println!("{name}: CONNECTED {code} in {:?}", started.elapsed()),
            Ok(Err(error)) => println!("{name}: refused ({error}) after {:?}", started.elapsed()),
            Err(_) => println!("{name}: no answer after {:?}", started.elapsed()),
        }
        client.shutdown().await;
    }
    cancel.cancel();
    let _ = task.await;
    Ok(())
}
