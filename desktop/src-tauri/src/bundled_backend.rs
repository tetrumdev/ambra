//! Runs the bundled `ambra-server` for the app's lifetime.
//!
//! The server is restarted if it dies, its output goes to a log file, and it
//! exits on its own if the app is killed (it watches the stdin pipe we hold).
//! If something already answers on the server port, such as a server started
//! with `cargo run` during development, it is used instead of a second copy.

use std::{
    env,
    fs::{self, OpenOptions},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const DEFAULT_ADDRESS: &str = "127.0.0.1:38147";
const POLL_INTERVAL: Duration = Duration::from_millis(500);
const MAX_RESTART_DELAY: Duration = Duration::from_secs(30);
/// A server that ran this long is considered healthy, resetting the backoff.
const STABLE_RUN: Duration = Duration::from_secs(60);
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;

pub struct BundledBackend {
    child: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
}

impl BundledBackend {
    pub fn start(log_path: Option<PathBuf>) -> Self {
        let backend = Self {
            child: Arc::new(Mutex::new(None)),
            stopping: Arc::new(AtomicBool::new(false)),
        };
        let Some(executable) = bundled_executable() else {
            return backend;
        };
        let child = backend.child.clone();
        let stopping = backend.stopping.clone();
        let spawned = thread::Builder::new()
            .name("ambra-server-supervisor".into())
            .spawn(move || supervise(&executable, log_path.as_deref(), &child, &stopping));
        if let Err(error) = spawned {
            eprintln!("Could not supervise the Ambra server: {error}");
        }
        backend
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let Ok(mut child) = self.child.lock() else {
            return;
        };
        if let Some(mut child) = child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for BundledBackend {
    fn drop(&mut self) {
        self.stop();
    }
}

fn bundled_executable() -> Option<PathBuf> {
    let executable = env::current_exe()
        .ok()?
        .parent()?
        .join(format!("ambra-server{}", env::consts::EXE_SUFFIX));
    executable.is_file().then_some(executable)
}

fn server_address() -> SocketAddr {
    env::var("AMBRA_SERVER_ADDRESS")
        .ok()
        .and_then(|address| address.parse().ok())
        .unwrap_or_else(|| DEFAULT_ADDRESS.parse().expect("valid default address"))
}

fn port_in_use(address: SocketAddr) -> bool {
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

fn supervise(
    executable: &Path,
    log_path: Option<&Path>,
    slot: &Mutex<Option<Child>>,
    stopping: &AtomicBool,
) {
    let address = server_address();
    let mut failures = 0_u32;
    while !stopping.load(Ordering::SeqCst) {
        if port_in_use(address) {
            sleep_unless_stopping(Duration::from_secs(5), stopping);
            continue;
        }

        let started = Instant::now();
        match spawn(executable, log_path) {
            Ok(child) => {
                {
                    let Ok(mut slot) = slot.lock() else { return };
                    if stopping.load(Ordering::SeqCst) {
                        let mut child = child;
                        let _ = child.kill();
                        let _ = child.wait();
                        return;
                    }
                    *slot = Some(child);
                }
                // Poll rather than block in wait(), so stop() can take and kill the child.
                loop {
                    thread::sleep(POLL_INTERVAL);
                    let Ok(mut guard) = slot.lock() else { return };
                    let Some(child) = guard.as_mut() else { return };
                    match child.try_wait() {
                        Ok(None) => continue,
                        Ok(Some(status)) => {
                            eprintln!("Ambra server exited ({status}); restarting");
                            guard.take();
                        }
                        Err(error) => {
                            eprintln!("Lost track of the Ambra server ({error}); restarting");
                            if let Some(mut child) = guard.take() {
                                let _ = child.kill();
                                let _ = child.wait();
                            }
                        }
                    }
                    break;
                }
            }
            Err(error) => eprintln!("Could not start the Ambra server: {error}"),
        }

        failures = if started.elapsed() >= STABLE_RUN { 1 } else { failures + 1 };
        let delay = Duration::from_secs(1 << failures.min(5)).min(MAX_RESTART_DELAY);
        sleep_unless_stopping(delay, stopping);
    }
}

fn sleep_unless_stopping(duration: Duration, stopping: &AtomicBool) {
    let deadline = Instant::now() + duration;
    while !stopping.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::sleep(POLL_INTERVAL.min(deadline - Instant::now()));
    }
}

fn spawn(executable: &Path, log_path: Option<&Path>) -> std::io::Result<Child> {
    let (stdout, stderr) = match log_path.and_then(open_log) {
        Some(log) => match log.try_clone() {
            Ok(copy) => (Stdio::from(log), Stdio::from(copy)),
            Err(_) => (Stdio::from(log), Stdio::null()),
        },
        None => (Stdio::null(), Stdio::null()),
    };
    let mut command = Command::new(executable);
    command
        .env("AMBRA_EXIT_WITH_PARENT", "1")
        // Held open by the Child; the OS closes it if the app dies.
        .stdin(Stdio::piped())
        .stdout(stdout)
        .stderr(stderr);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

fn open_log(path: &Path) -> Option<fs::File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok()?;
    }
    let oversized = fs::metadata(path).is_ok_and(|metadata| metadata.len() > MAX_LOG_BYTES);
    if oversized {
        let _ = fs::rename(path, path.with_extension("log.old"));
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}
