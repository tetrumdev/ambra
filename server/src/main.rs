mod access;
mod api;
mod artwork_cache;
mod artwork_quality;
mod browser_auth;
mod cli;
mod credits;
mod discovery;
mod endpoints;
mod firewall;
mod flac_remux;
mod http_client;
mod impulses;
mod loudness;
mod local_music;
mod lyrics;
mod media_cache;
mod metadata_store;
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

/// The server runs for days with a worker thread per core. glibc keeps a separate pool of
/// memory for each thread and returns freed memory only from the top of one: after a burst
/// of large JSON bodies or decoded covers on many threads, the process went on holding
/// around a gigabyte it no longer used. Asking glibc to give free pages back once a minute
/// costs little and keeps what the server holds close to what it uses.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn return_unused_memory_periodically() {
    tokio::spawn(async {
        let mut ticks = tokio::time::interval(std::time::Duration::from_secs(60));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticks.tick().await;
            // Takes each pool's lock in turn, like any allocation; off the async workers
            // because a large pool takes a few milliseconds to walk.
            let _ = tokio::task::spawn_blocking(|| unsafe { libc::malloc_trim(0) }).await;
        }
    });
}
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn return_unused_memory_periodically() {}

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
            // Windows sleeps in ~15.6 ms ticks by default, which throttles paced
            // peer-to-peer sends to a couple of packets per tick. The 1 ms
            // resolution applies to this process only and ends when it exits.
            #[cfg(windows)]
            unsafe {
                windows::Win32::Media::timeBeginPeriod(1);
            }
            storage::migrate_legacy();
            return_unused_memory_periodically();
            if tray && cfg!(target_os = "windows") {
                let server = tokio::spawn(async move {
                    let result = api::serve(bind).await;
                    tray::quit();
                    result
                });
                // The tray is optional: SSH sessions have no Explorer, and the shell may
                // still be starting at login. Its failure must not stop the server.
                let _ = tray::run();
                server.await?
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
