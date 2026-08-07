mod providers;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    providers::tidal::run().await
}
