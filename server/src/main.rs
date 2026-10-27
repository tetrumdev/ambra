mod access;
mod api;
mod artwork_cache;
mod artwork_quality;
mod cli;
mod credits;
mod discovery;
mod endpoints;
mod http_client;
mod impulses;
mod loudness;
mod local_music;
mod lyrics;
mod media_cache;
mod models;
mod network;
mod p2p;
mod playlists;
mod providers;
mod recommendations;
mod remote;
mod server_process;
mod server_config;
mod session;
mod service_auth;
mod soloist;
#[allow(dead_code)] // Shared protocol includes both producer and consumer helpers.
#[path = "../../shared/live_pcm.rs"]
mod live_pcm;
mod storage;
mod tray;
mod user_state;
mod write_behind;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match cli::parse(std::env::args().skip(1).collect()) {
        Ok(cli::Command::Start { bind }) => {
            match server_process::start(bind).await {
                Ok(message) => { println!("{message}"); Ok(()) }
                Err(message) => { eprintln!("{message}"); std::process::exit(1); }
            }
        }
        Ok(cli::Command::Serve { bind, tray }) => {
            let _ = tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into())).with_writer(std::io::stderr).with_ansi(false).try_init();
            let _lock = server_process::lock()?;
            storage::migrate_legacy();
            if tray && cfg!(target_os = "windows") {
                tokio::spawn(async move {
                    if let Err(error) = api::serve(bind).await {
                        eprintln!("{error}");
                    }
                    tray::quit();
                });
                tray::run().map_err(Into::into)
            } else {
                api::serve(bind).await
            }
        }
        Ok(cli::Command::Run(arguments)) => {
            match cli::run(arguments).await {
                Ok(output) => {
                    println!("{output}");
                    Ok(())
                }
                Err(message) => {
                    eprintln!("{message}");
                    std::process::exit(1);
                }
            }
        }
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    }
}
