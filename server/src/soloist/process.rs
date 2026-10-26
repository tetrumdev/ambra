//! Child ownership and bounded output. Never format a Command: argv contains the API key.
use std::{
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use super::{Error, ErrorCode, config::ApiKey};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    task::JoinHandle,
};

pub struct Process {
    pub child: Child,
    logs: Vec<JoinHandle<()>>,
    diagnostic: Arc<Mutex<Option<ErrorCode>>>,
}

impl Process {
    pub fn spawn(command: &mut Command, key: Option<&ApiKey>) -> Result<Self, Error> {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(target_os = "linux")]
        unsafe {
            let parent = libc::getpid();
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(std::io::Error::other("Parent process exited"));
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(|_| {
            Error::new(
                ErrorCode::ProcessFailed,
                "Could not start Soloist or its capture helper",
            )
        })?;
        let mut logs = Vec::new();
        let diagnostic = Arc::new(Mutex::new(None));
        // Fixed blocks bound memory even if the executable writes a line without a newline.
        // Raw process output is intentionally not persisted: it can contain opaque session
        // credentials as well as the known API key. Only sanitized diagnostics are retained
        // when explicitly requested in development.
        for pipe in [
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let secret =
                key.map(|key| ApiKey::parse(key.expose().to_owned()).expect("validated key"));
            let diagnostic = diagnostic.clone();
            logs.push(tokio::spawn(async move {
                let mut pipe = pipe;
                let mut block = [0_u8; 4096];
                let mut line = Vec::with_capacity(8192);
                while let Ok(size) = pipe.read(&mut block).await {
                    if size == 0 {
                        break;
                    }
                    for byte in &block[..size] {
                        if *byte == b'\n' || line.len() >= 8192 {
                            let raw = String::from_utf8_lossy(&line);
                            let clean = secret
                                .as_ref()
                                .map_or_else(|| raw.to_string(), |key| key.redact(&raw));
                            if let Some(code) = classify_log(&clean) {
                                *diagnostic.lock().unwrap() = Some(code);
                            }
                            line.clear();
                        } else {
                            line.push(*byte);
                        }
                    }
                }
                if !line.is_empty() {
                    let raw = String::from_utf8_lossy(&line);
                    let clean = secret
                        .as_ref()
                        .map_or_else(|| raw.to_string(), |key| key.redact(&raw));
                    if let Some(code) = classify_log(&clean) {
                        *diagnostic.lock().unwrap() = Some(code);
                    }
                }
            }));
        }
        Ok(Self {
            child,
            logs,
            diagnostic,
        })
    }

    pub fn failure(&self) -> Option<Error> {
        self.diagnostic.lock().unwrap().map(|code| {
            Error::new(
                code,
                match code {
                    ErrorCode::InvalidApiKey => {
                        "Soloist rejected the personal API key. Replace it on the server machine."
                    }
                    ErrorCode::Busy => "Another Soloist session is using the same data directory.",
                    ErrorCode::AuthenticationFailed => {
                        "Soloist login failed. Verify pairing and account access."
                    }
                    _ => "Soloist process failed.",
                },
            )
        })
    }
    /// After exit, allow pipe readers to classify trailing diagnostics before reporting.
    pub async fn finish_logs(&mut self) {
        for mut log in self.logs.drain(..) {
            if tokio::time::timeout(Duration::from_millis(250), &mut log)
                .await
                .is_err()
            {
                log.abort();
                let _ = log.await;
            }
        }
    }
    pub async fn stop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            #[cfg(unix)]
            if let Some(pid) = self.child.id() {
                // The child owns a fresh process group. Do not signal an inherited group.
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGTERM);
                }
            }
            #[cfg(not(unix))]
            let _ = self.child.start_kill();
            if tokio::time::timeout(Duration::from_secs(2), self.child.wait())
                .await
                .is_err()
            {
                #[cfg(unix)]
                if let Some(pid) = self.child.id() {
                    unsafe {
                        libc::kill(-(pid as i32), libc::SIGKILL);
                    }
                }
                let _ = self.child.start_kill();
                let _ = self.child.wait().await;
            }
        }
        self.finish_logs().await;
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
        for log in &self.logs {
            log.abort();
        }
    }
}

fn classify_log(text: &str) -> Option<ErrorCode> {
    let text = text.to_ascii_lowercase();
    if text.contains("invalid api key")
        || text.contains("api key rejected")
        || text.contains("invalid api-key")
    {
        Some(ErrorCode::InvalidApiKey)
    } else if text.contains("another session is running") {
        Some(ErrorCode::Busy)
    } else if text.contains("login failed") {
        Some(ErrorCode::AuthenticationFailed)
    } else {
        None
    }
}

pub async fn bounded_output(
    command: &mut Command,
) -> Result<(std::process::ExitStatus, Vec<u8>), Error> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| {
        Error::new(
            ErrorCode::ProcessFailed,
            "Could not run executable validation or capture control",
        )
    })?;
    let stdout = child.stdout.take().expect("piped stdout");
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let mut output = Vec::new();
        stdout
            .take(64 * 1024 + 1)
            .read_to_end(&mut output)
            .await
            .map_err(Error::io)?;
        if output.len() > 64 * 1024 {
            return Err(Error::new(
                ErrorCode::ProcessFailed,
                "Helper output exceeded its limit",
            ));
        }
        let status = child.wait().await.map_err(Error::io)?;
        Ok((status, output))
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            Err(Error::new(
                ErrorCode::ProcessFailed,
                "Executable validation or capture control timed out",
            ))
        }
    }
}

/// Restart only before audio delivery; a mid-track crash must produce a stream error.
pub fn restart_delay(attempt: u32) -> Option<Duration> {
    (attempt < 3).then(|| Duration::from_secs(1 << attempt))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retries_are_bounded_and_exponential() {
        assert_eq!(restart_delay(0), Some(Duration::from_secs(1)));
        assert_eq!(restart_delay(2), Some(Duration::from_secs(4)));
        assert_eq!(restart_delay(3), None);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stop_reaps_child_and_exit_ten_survives() {
        let mut process =
            Process::spawn(Command::new("/bin/sh").args(["-c", "sleep 30"]), None).unwrap();
        process.stop().await;
        assert!(process.child.try_wait().unwrap().is_some());
        let (status, _) = bounded_output(Command::new("/bin/sh").args(["-c", "exit 10"]))
            .await
            .unwrap();
        assert_eq!(status.code(), Some(10));
    }
}
