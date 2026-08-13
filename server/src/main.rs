mod api;
mod artwork_quality;
mod models;
mod providers;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    api::serve().await
}
