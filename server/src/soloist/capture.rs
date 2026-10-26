//! A per-run private PulseAudio server: no hardware modules, no host PipeWire socket.
use super::{
    Error, ErrorCode,
    process::{Process, bounded_output},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::process::Command;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub available: bool,
    pub reason: String,
}

pub fn capability() -> Capability {
    if !cfg!(target_os = "linux") {
        return Capability { available: false, reason: "Server PCM capture currently requires Linux. Core Audio process taps and WASAPI application loopback are not implemented; binary management and pairing remain available.".into() };
    }
    let available = ["pulseaudio", "pactl"]
        .into_iter()
        .all(|name| executable(name).is_some());
    Capability { available, reason: if available { "Private PulseAudio S32LE stereo capture is available; routing is verified at stream startup." } else { "Install pulseaudio and pulseaudio-utils (pactl) on the Linux server." }.into() }
}
fn executable(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    })
}

pub fn private_directory(path: &Path) -> Result<(), Error> {
    std::fs::create_dir_all(path).map_err(Error::io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(Error::io)?;
    }
    Ok(())
}

pub struct Capture {
    process: Option<Process>,
    runtime: PathBuf,
    address: String,
    sink_index: u32,
    #[cfg(unix)]
    fifo: Option<tokio::io::unix::AsyncFd<std::fs::File>>,
}
impl Capture {
    pub async fn start(root: &Path) -> Result<Self, Error> {
        let capability = capability();
        if !capability.available {
            return Err(Error::new(
                ErrorCode::CaptureUnavailable,
                &capability.reason,
            ));
        }
        private_directory(root)?;
        let runtime = root.join(crate::server_config::random_hex(8));
        private_directory(&runtime)?;
        // PulseAudio's module argument parser has no portable escaping for these paths.
        if runtime.to_string_lossy().chars().any(char::is_whitespace)
            || runtime.as_os_str().len() > 80
        {
            let _ = std::fs::remove_dir(&runtime);
            return Err(Error::new(
                ErrorCode::SinkStartupFailed,
                "The Linux capture cache path must be short and contain no whitespace; set AMBRA_CACHE_DIR to a private short path",
            ));
        }
        let socket = runtime.join("native");
        let fifo = runtime.join("audio.pcm");
        let script = runtime.join("capture.pa");
        let config = format!(
            "load-module module-native-protocol-unix socket={} auth-anonymous=1\nload-module module-pipe-sink sink_name=ambra file={} format=s32le rate=44100 channels=2\nset-default-sink ambra\n",
            socket.display(),
            fifo.display()
        );
        crate::server_config::write_private(&script, config.as_bytes()).map_err(Error::storage)?;
        let mut capture = Self {
            process: None,
            address: format!("unix:{}", socket.display()),
            sink_index: 0,
            runtime,
            #[cfg(unix)]
            fifo: None,
        };
        let mut command =
            Command::new(executable("pulseaudio").ok_or_else(|| {
                Error::new(ErrorCode::CaptureUnavailable, "PulseAudio is missing")
            })?);
        command
            .args([
                "--daemonize=no",
                "-n",
                "--exit-idle-time=-1",
                "--use-pid-file=no",
                "--disallow-exit=yes",
            ])
            .arg(format!("--file={}", script.display()))
            .env("XDG_RUNTIME_DIR", &capture.runtime)
            .env("PULSE_RUNTIME_PATH", &capture.runtime)
            .env("PULSE_STATE_PATH", &capture.runtime);
        capture.process = Some(Process::spawn(&mut command, None)?);
        let result = async {
            tokio::time::timeout(Duration::from_secs(5), async {
                while !socket.exists() || !fifo.exists() {
                    capture.check_alive()?;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Ok::<_, Error>(())
            })
            .await
            .map_err(|_| {
                Error::new(
                    ErrorCode::SinkStartupFailed,
                    "Private PulseAudio server did not create its sink and FIFO",
                )
            })??;
            capture
                .control(&["set-sink-volume", "ambra", "65536"])
                .await?;
            capture.suspend(true).await?;
            let output = capture.control(&["--format=json", "list", "sinks"]).await?;
            capture.sink_index = validate_sink(&output)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
                if !std::fs::symlink_metadata(&fifo)
                    .map_err(Error::io)?
                    .file_type()
                    .is_fifo()
                {
                    return Err(Error::new(
                        ErrorCode::SinkStartupFailed,
                        "Capture output is not a FIFO",
                    ));
                }
                let reader = std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
                    .open(fifo)
                    .map_err(Error::io)?;
                capture.fifo = Some(tokio::io::unix::AsyncFd::new(reader).map_err(Error::io)?);
            }
            Ok::<_, Error>(())
        }
        .await;
        if let Err(error) = result {
            capture.stop().await;
            return Err(error);
        }
        Ok(capture)
    }
    pub fn route(&self, command: &mut Command) {
        command
            .env("PULSE_SERVER", &self.address)
            .env("PULSE_SINK", "ambra")
            .env("PULSE_RUNTIME_PATH", &self.runtime)
            .env("XDG_RUNTIME_DIR", &self.runtime)
            .env("PIPEWIRE_RUNTIME_DIR", &self.runtime)
            .env("PIPEWIRE_REMOTE", "ambra-disabled")
            .env_remove("PIPEWIRE_NODE")
            .env_remove("PIPEWIRE_PROPS")
            .env_remove("PULSE_SOURCE");
    }
    pub fn check_alive(&mut self) -> Result<(), Error> {
        let exited = match self.process.as_mut() {
            Some(process) => process
                .child
                .try_wait()
                .map_err(|_| {
                    Error::new(
                        ErrorCode::SinkStartupFailed,
                        "Cannot inspect private PulseAudio capture process",
                    )
                })?
                .is_some(),
            None => true,
        };
        if exited {
            return Err(Error::new(
                ErrorCode::SinkStartupFailed,
                "Private PulseAudio capture server exited",
            ));
        }
        Ok(())
    }
    async fn control(&self, args: &[&str]) -> Result<Vec<u8>, Error> {
        let (status, output) = bounded_output(
            Command::new(
                executable("pactl")
                    .ok_or_else(|| Error::new(ErrorCode::CaptureUnavailable, "pactl is missing"))?,
            )
            .arg("--server")
            .arg(&self.address)
            .args(args),
        )
        .await?;
        if !status.success() {
            return Err(Error::new(
                ErrorCode::SinkStartupFailed,
                "Private audio sink control failed; capture stopped",
            ));
        }
        Ok(output)
    }
    pub async fn suspend(&self, suspend: bool) -> Result<(), Error> {
        self.control(&["suspend-sink", "ambra", if suspend { "1" } else { "0" }])
            .await
            .map(|_| ())
    }
    pub async fn verify_route(&self, pid: u32) -> Result<bool, Error> {
        let sinks = self.control(&["--format=json", "list", "sinks"]).await?;
        if validate_sink(&sinks)? != self.sink_index {
            return Err(Error::new(
                ErrorCode::CaptureUnavailable,
                "Private capture sink was replaced",
            ));
        }
        let output = self
            .control(&["--format=json", "list", "sink-inputs"])
            .await?;
        validate_route(&output, pid, self.sink_index)
    }
    /// Discard only pre-roll already in the pipe while the sink is explicitly suspended.
    /// This is a lifecycle boundary, never a silence detector or content trimmer.
    #[cfg(unix)]
    pub fn discard_pending(&mut self) -> Result<(), Error> {
        use std::io::Read;
        let file = self.fifo.as_ref().ok_or_else(|| {
            Error::new(ErrorCode::CaptureUnavailable, "Capture FIFO is unavailable")
        })?;
        let mut bytes = [0; 8192];
        for _ in 0..32 {
            match file.get_ref().read(&mut bytes) {
                Ok(0) => return Ok(()),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
                Err(error) => return Err(Error::io(error)),
            }
        }
        Err(Error::new(
            ErrorCode::SinkStartupFailed,
            "Private sink did not suspend before capture startup",
        ))
    }
    #[cfg(not(unix))]
    pub fn discard_pending(&mut self) -> Result<(), Error> {
        Err(Error::new(
            ErrorCode::CaptureUnavailable,
            "Native capture is not implemented on this platform",
        ))
    }
    #[cfg(unix)]
    pub async fn read(&mut self, bytes: &mut [u8]) -> Result<usize, Error> {
        use std::io::Read;
        let file = self.fifo.as_ref().ok_or_else(|| {
            Error::new(ErrorCode::CaptureUnavailable, "Capture FIFO is unavailable")
        })?;
        loop {
            let mut ready = file.readable().await.map_err(Error::io)?;
            match ready.try_io(|inner| inner.get_ref().read(bytes)) {
                Ok(result) => return result.map_err(Error::io),
                Err(_) => continue,
            }
        }
    }
    #[cfg(not(unix))]
    pub async fn read(&mut self, _bytes: &mut [u8]) -> Result<usize, Error> {
        Err(Error::new(
            ErrorCode::CaptureUnavailable,
            "Native capture is not implemented on this platform",
        ))
    }
    pub async fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            process.stop().await;
        }
        #[cfg(unix)]
        {
            self.fifo = None;
        }
        let _ = std::fs::remove_dir_all(&self.runtime);
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.process.take();
        let _ = std::fs::remove_dir_all(&self.runtime);
    }
}

#[derive(Deserialize)]
struct Volume {
    value: u32,
}
#[derive(Deserialize)]
struct Sink {
    index: u32,
    name: String,
    sample_specification: String,
    mute: bool,
    volume: std::collections::HashMap<String, Volume>,
}
fn validate_sink(output: &[u8]) -> Result<u32, Error> {
    let sinks: Vec<Sink> = serde_json::from_slice(output).map_err(|_| {
        Error::new(
            ErrorCode::SinkStartupFailed,
            "Cannot inspect private audio sink",
        )
    })?;
    if sinks.len() != 1
        || sinks[0].name != "ambra"
        || sinks[0].sample_specification != "s32le 2ch 44100Hz"
        || sinks[0].mute
        || sinks[0].volume.len() != 2
        || sinks[0].volume.values().any(|v| v.value != 65536)
    {
        return Err(Error::new(
            ErrorCode::SinkStartupFailed,
            "Capture requires exactly one private S32LE 44,100 Hz stereo sink at unity gain",
        ));
    }
    Ok(sinks[0].index)
}
#[derive(Deserialize)]
struct Input {
    sink: u32,
    sample_specification: String,
    mute: bool,
    properties: std::collections::HashMap<String, String>,
    volume: std::collections::HashMap<String, Volume>,
}
fn validate_route(output: &[u8], pid: u32, sink_index: u32) -> Result<bool, Error> {
    let inputs: Vec<Input> = serde_json::from_slice(output).map_err(|_| {
        Error::new(
            ErrorCode::CaptureUnavailable,
            "Cannot verify Soloist audio routing",
        )
    })?;
    if inputs.is_empty() {
        return Ok(false);
    }
    // Other inputs or attenuation fail closed rather than silently mixing or changing samples.
    if inputs.len() != 1
        || inputs[0].sink != sink_index
        || !inputs[0].sample_specification.ends_with(" 2ch 44100Hz")
        || inputs[0].mute
        || inputs[0].properties.get("application.process.id") != Some(&pid.to_string())
        || inputs[0].volume.len() != 2
        || inputs[0].volume.values().any(|v| v.value != 65536)
    {
        return Err(Error::new(
            ErrorCode::CaptureUnavailable,
            "Soloist is not the sole unity-gain input on the private capture sink; refusing audio forwarding",
        ));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_requires_verified_pid_and_unity_gain() {
        let good = br#"[{"sink":0,"sample_specification":"s32le 2ch 44100Hz","mute":false,"properties":{"application.process.id":"123"},"volume":{"front-left":{"value":65536},"front-right":{"value":65536}}}]"#;
        assert!(validate_route(good, 123, 0).unwrap());
        assert!(validate_route(good, 124, 0).is_err());
        assert!(!validate_route(b"[]", 123, 0).unwrap());
        assert!(
            validate_route(
                &String::from_utf8_lossy(good)
                    .replace("65536", "70000")
                    .into_bytes(),
                123,
                0
            )
            .is_err()
        );
        assert!(
            validate_route(
                &String::from_utf8_lossy(good)
                    .replace("44100", "48000")
                    .into_bytes(),
                123,
                0
            )
            .is_err()
        );
        assert!(validate_sink(br#"[{"index":0,"name":"ambra","sample_specification":"s32le 2ch 44100Hz","mute":false,"volume":{"front-left":{"value":65536},"front-right":{"value":65536}}}]"#).is_ok());
    }

    /// Synthetic PCM only. Run explicitly on Linux with PulseAudio utilities installed.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "requires Linux pulseaudio, pactl, and paplay"]
    async fn linux_private_sink_captures_synthetic_pcm_without_hardware() {
        let root =
            std::env::temp_dir().join(format!("amb-cap-{}", crate::server_config::random_hex(4)));
        private_directory(&root).unwrap();
        let source = root.join("synthetic.pcm");
        let samples: Vec<u8> = (0..44_100)
            .flat_map(|frame| {
                let value: i32 = if frame % 100 < 50 {
                    0x10000000
                } else {
                    -0x10000000
                };
                [value.to_le_bytes(), value.to_le_bytes()].concat()
            })
            .collect();
        std::fs::write(&source, &samples).unwrap();
        let mut capture = Capture::start(&root).await.unwrap();
        let mut command = Command::new("paplay");
        command
            .args([
                "--raw",
                "--format=s32le",
                "--rate=44100",
                "--channels=2",
                "--volume=65536",
                "--device=ambra",
            ])
            .arg(&source);
        capture.route(&mut command);
        let mut player = Process::spawn(&mut command, None).unwrap();
        let pid = player.child.id().unwrap();
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            while !capture.verify_route(pid).await? {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            capture.discard_pending()?;
            capture.suspend(false).await?;
            let mut block = [0; 8192];
            let mut captured = Vec::new();
            while captured.len() < 44_100 * 8 / 2 {
                let size = capture.read(&mut block).await?;
                if size == 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }
                captured.extend_from_slice(&block[..size]);
                tokio::time::sleep(Duration::from_secs_f64(size as f64 / 352_800.0)).await;
            }
            assert!(captured.chunks_exact(4).any(|sample| {
                i32::from_le_bytes(sample.try_into().unwrap()).abs() == 0x10000000
            }));
            Ok::<_, Error>(())
        })
        .await;
        player.stop().await;
        capture.stop().await;
        assert!(!capture.runtime.exists());
        std::fs::remove_dir_all(root).unwrap();
        result.expect("capture timed out").unwrap();
    }
}
