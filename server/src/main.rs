mod api;
mod artwork_quality;
mod login_setup;
mod media_cache;
mod models;
mod providers;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match login_setup::command()? {
        login_setup::Command::RunServer => api::serve().await,
        login_setup::Command::ResetLogins => Ok(login_setup::reset()?),
    }
}
