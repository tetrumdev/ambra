use super::{
    Error, ErrorCode, Paths, State,
    binary::Build,
    capture::Capture,
    config::{ApiKey, Quality},
    control::{self, PlaybackState},
    process::{Process, restart_delay},
};
use crate::live_pcm::{self, StreamInfo};
use bytes::Bytes;
use std::{
    fs::File,
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::{process::Command, sync::mpsc};
use tokio_util::sync::CancellationToken;

pub struct Runtime {
    process: Option<Process>,
    capture: Option<Capture>,
    control_cancel: CancellationToken,
    client: Option<control::Client>,
    _lease: File,
    audio_started: bool,
}
impl Runtime {
    pub fn new(paths: &Paths) -> Result<Self, Error> {
        Ok(Self {
            process: None,
            capture: None,
            control_cancel: CancellationToken::new(),
            client: None,
            _lease: paths.lock()?,
            audio_started: false,
        })
    }
    pub async fn close(&mut self) {
        self.control_cancel.cancel();
        if let Some(mut process) = self.process.take() {
            process.stop().await;
        }
        if let Some(mut capture) = self.capture.take() {
            capture.stop().await;
        }
    }
    pub async fn pair(
        &mut self,
        binary: &std::path::Path,
        key: &ApiKey,
        paths: &Paths,
    ) -> Result<(), Error> {
        paths.clear_runtime()?;
        let mut command = soloist_command(binary, key, paths);
        command.arg("--pair");
        self.process = Some(Process::spawn(&mut command, Some(key))?);
        let status = tokio::time::timeout(Duration::from_secs(300), self.process.as_mut().unwrap().child.wait()).await
            .map_err(|_| Error::new(ErrorCode::PairingRequired, "Pairing timed out. Open Spotify on the same network and select Ambra Soloist Pairing."))?.map_err(Error::io)?;
        self.process.as_mut().unwrap().finish_logs().await;
        if status.code() != Some(10)
            && !status.success()
            && let Some(error) = self.process.as_ref().unwrap().failure()
        {
            return Err(error);
        }
        check_exit(status.code())?;
        if !paths.paired() {
            return Err(Error::new(
                ErrorCode::AuthenticationFailed,
                "Soloist exited without saving a paired account",
            ));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn play(
        &mut self,
        binary: PathBuf,
        build: &Build,
        key: &ApiKey,
        paths: &Paths,
        quality: Quality,
        info: &StreamInfo,
        sender: &mpsc::Sender<Bytes>,
        changed: &impl Fn(State),
    ) -> Result<(), Error> {
        paths.clear_runtime()?;
        super::prefs::write(&paths.session, &build.version, quality)?;
        self.capture = Some(Capture::start(&paths.capture).await?);
        let mut command = soloist_command(&binary, key, paths);
        command.args([
            "--single-track",
            &format!("spotify:track:{}", info.track_id),
        ]);
        self.capture.as_ref().unwrap().route(&mut command);
        self.process = Some(Process::spawn(&mut command, Some(key))?);
        let pid =
            self.process.as_ref().unwrap().child.id().ok_or_else(|| {
                Error::new(ErrorCode::ProcessFailed, "Soloist exited during startup")
            })?;
        let client =
            control::Client::start(paths.session.clone(), self.control_cancel.child_token());
        let mut observed = client.observed.clone();
        self.client = Some(client.clone());
        let expected = format!("spotify:track:{}", info.track_id);
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut confirmed = false;
        let mut seek_sent_at = Instant::now() - Duration::from_secs(2);
        let mut seek_serial = 0;
        loop {
            self.check_process().await?;
            self.capture.as_mut().unwrap().check_alive()?;
            let state = observed.borrow().clone();
            if let Some(error) = state.error {
                return Err(error);
            }
            if let Some(item) = &state.item {
                if item.uri != expected {
                    return Err(Error::new(
                        ErrorCode::AccountRestricted,
                        "Soloist selected a different track; Ambra retains queue ownership",
                    ));
                }
                confirmed = state.logged_in == Some(true) && state.state == PlaybackState::Playing;
            }
            if confirmed && self.capture.as_ref().unwrap().verify_route(pid).await? {
                if info.start_position_seconds <= 0.0 {
                    break;
                }
                if state.serial > seek_serial
                    && seek_serial > 0
                    && state.position.as_ref().is_some_and(|position| {
                        position
                            .position_ms
                            .abs_diff((info.start_position_seconds * 1000.0) as u64)
                            <= 1500
                    })
                {
                    break;
                }
                if seek_sent_at.elapsed() >= Duration::from_secs(1) {
                    seek_serial = state.serial;
                    client
                        .send(control::Command::Seek {
                            position_ms: (info.start_position_seconds * 1000.0) as u64,
                        })
                        .await?;
                    seek_sent_at = Instant::now();
                }
            }
            if Instant::now() >= deadline {
                return Err(Error::new(
                    ErrorCode::PlaybackStalled,
                    "Soloist did not confirm the requested track, seek, and private audio route within 30 seconds",
                ));
            }
            tokio::select! { _ = observed.changed() => {}, _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
        }
        client
            .send(control::Command::SetVolume { volume: 100 })
            .await?;
        // Volume is verified from an observation, never from its command acknowledgement.
        let mut volume_deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            if observed.borrow().volume == Some(100) {
                break;
            }
            client.send(control::Command::GetState).await?;
            if tokio::time::timeout_at(volume_deadline, observed.changed())
                .await
                .is_err()
            {
                return Err(Error::new(
                    ErrorCode::ControlFailed,
                    "Soloist did not confirm unity volume",
                ));
            }
            volume_deadline =
                volume_deadline.min(tokio::time::Instant::now() + Duration::from_secs(3));
        }
        self.capture.as_mut().unwrap().discard_pending()?;
        self.capture.as_ref().unwrap().suspend(false).await?;
        changed(State::Playing);
        let mut block = [0; live_pcm::MAX_CHUNK];
        let mut partial = Vec::with_capacity(live_pcm::MAX_CHUNK + live_pcm::FRAME_BYTES);
        let mut delivered = 0_usize;
        let mut pace = Instant::now();
        let mut paced = 0_usize;
        let mut stalled = Instant::now();
        let mut exited: Option<Instant> = None;
        let mut suspended = false;
        let mut last_poll = Instant::now();
        loop {
            self.capture.as_mut().unwrap().check_alive()?;
            if exited.is_none()
                && let Some(status) = self
                    .process
                    .as_mut()
                    .unwrap()
                    .child
                    .try_wait()
                    .map_err(Error::io)?
            {
                self.process.as_mut().unwrap().finish_logs().await;
                if status.code() == Some(10) {
                    return Err(Error::expired());
                }
                if !status.success()
                    && let Some(error) = self.process.as_ref().unwrap().failure()
                {
                    return Err(error);
                }
                check_exit(status.code())?;
                exited = Some(Instant::now());
            }
            if exited.is_some_and(|at| at.elapsed() >= Duration::from_millis(500)) {
                break;
            }
            let state = observed.borrow().clone();
            if let Some(error) = state.error
                && exited.is_none()
            {
                return Err(error);
            }
            if let Some(item) = &state.item
                && item.uri != expected
            {
                return Err(Error::new(
                    ErrorCode::StreamInterrupted,
                    "Soloist changed tracks outside Ambra; stale audio was discarded",
                ));
            }
            if state.logged_in == Some(false) {
                return Err(Error::new(
                    ErrorCode::AuthenticationFailed,
                    "Soloist lost its Spotify authentication",
                ));
            }
            if exited.is_none() && confirmed && state.is_active == Some(false) {
                return Err(Error::new(
                    ErrorCode::AccountRestricted,
                    "Spotify playback moved to another device",
                ));
            }
            if exited.is_none() && last_poll.elapsed() >= Duration::from_secs(2) {
                client.send(control::Command::GetState).await?;
                if state.volume.is_some_and(|v| v != 100) {
                    client
                        .send(control::Command::SetVolume { volume: 100 })
                        .await?;
                }
                if !self.capture.as_ref().unwrap().verify_route(pid).await? {
                    return Err(Error::new(
                        ErrorCode::CaptureUnavailable,
                        "Soloist lost its private capture route",
                    ));
                }
                last_poll = Instant::now();
            }
            let buffering = !state.connected
                || matches!(
                    state.state,
                    PlaybackState::Buffering | PlaybackState::Paused | PlaybackState::Idle
                )
                || state.volume != Some(100);
            if buffering && exited.is_none() {
                if !suspended {
                    self.capture.as_ref().unwrap().suspend(true).await?;
                    suspended = true;
                    changed(State::Buffering);
                }
                if stalled.elapsed() >= Duration::from_secs(30) {
                    return Err(Error::new(
                        ErrorCode::PlaybackStalled,
                        "Soloist playback stalled for 30 seconds",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                pace = Instant::now();
                paced = 0;
                continue;
            }
            if suspended {
                self.capture.as_ref().unwrap().suspend(false).await?;
                suspended = false;
                changed(State::Playing);
            }
            let count = match tokio::time::timeout(
                Duration::from_millis(250),
                self.capture.as_mut().unwrap().read(&mut block),
            )
            .await
            {
                Ok(Ok(count)) if count > 0 => count,
                Ok(Ok(_)) | Err(_) => {
                    if exited.is_some() {
                        break;
                    }
                    if stalled.elapsed() >= Duration::from_secs(30) {
                        return Err(Error::new(
                            ErrorCode::PlaybackStalled,
                            "Soloist stopped delivering captured audio",
                        ));
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    pace = Instant::now();
                    paced = 0;
                    continue;
                }
                Ok(Err(error)) => return Err(error),
            };
            stalled = Instant::now();
            partial.extend_from_slice(&block[..count]);
            let aligned = partial.len() / live_pcm::FRAME_BYTES * live_pcm::FRAME_BYTES;
            if aligned == 0 {
                continue;
            }
            let length = aligned.min(live_pcm::MAX_CHUNK);
            let frame = live_pcm::audio_frame(&partial[..length]).map_err(Error::io)?;
            // A full downstream buffer stops the sink before waiting. Nothing is dropped.
            let full = sender.capacity() == 0;
            if full {
                self.capture.as_ref().unwrap().suspend(true).await?;
            }
            self.audio_started = true;
            tokio::time::timeout(Duration::from_secs(10), sender.send(Bytes::from(frame)))
                .await
                .map_err(|_| {
                    Error::new(
                        ErrorCode::StreamInterrupted,
                        "Selected output stopped consuming live audio",
                    )
                })?
                .map_err(|_| Error::cancelled())?;
            if full {
                self.capture.as_ref().unwrap().suspend(false).await?;
                pace = Instant::now();
                paced = 0;
            }
            partial.drain(..length);
            delivered += length;
            paced += length;
            // The FIFO is reader-clocked. Bound its demand and avoid catch-up bursts after stalls.
            let due =
                Duration::from_secs_f64(paced as f64 / live_pcm::BYTES_PER_SECOND as f64 / 1.05);
            if due > pace.elapsed() + Duration::from_millis(250) {
                tokio::time::sleep(due - pace.elapsed() - Duration::from_millis(250)).await;
            }
        }
        if !partial.is_empty() {
            return Err(Error::new(
                ErrorCode::StreamInterrupted,
                "Capture ended with an incomplete PCM sample frame",
            ));
        }
        let played = delivered as f64 / live_pcm::BYTES_PER_SECOND as f64;
        let expected_duration = info.duration_seconds - info.start_position_seconds;
        if played < 0.05 || expected_duration > 0.0 && played + 2.0 < expected_duration {
            return Err(Error::new(
                ErrorCode::TrackUnavailable,
                "Soloist ended before the requested track was fully delivered",
            ));
        }
        Ok(())
    }
    async fn check_process(&mut self) -> Result<(), Error> {
        if let Some(status) = self
            .process
            .as_mut()
            .unwrap()
            .child
            .try_wait()
            .map_err(Error::io)?
        {
            self.process.as_mut().unwrap().finish_logs().await;
            if status.code() == Some(10) {
                return Err(Error::expired());
            }
            if !status.success()
                && let Some(error) = self.process.as_ref().unwrap().failure()
            {
                return Err(error);
            }
            check_exit(status.code())?;
            return Err(Error::new(
                ErrorCode::TrackUnavailable,
                "Soloist exited before playback started; check pairing and track availability",
            ));
        }
        Ok(())
    }
}

fn soloist_command(binary: &std::path::Path, key: &ApiKey, paths: &Paths) -> Command {
    let mut command = Command::new(binary);
    command
        .args([
            "--device-name",
            "Ambra Soloist Pairing",
            "--api-key",
            key.expose(),
            "--data-dir",
        ])
        .arg(&paths.session)
        .arg("--cache-dir")
        .arg(&paths.cache)
        .args([
            "--cache-size",
            "512",
            "--initial-volume",
            "100",
            "--ws",
            "127.0.0.1:0",
        ]);
    command
}
fn check_exit(code: Option<i32>) -> Result<(), Error> {
    match code {
        Some(0) => Ok(()),
        Some(10) => Err(Error::expired()),
        _ => Err(Error::new(
            ErrorCode::ProcessFailed,
            "Soloist terminated unexpectedly; verify API key, pairing, account restrictions, and network connectivity",
        )),
    }
}

/// No automatic replay after delivery begins. Retry startup failures only, using fresh sinks.
#[allow(clippy::too_many_arguments)]
pub async fn stream(
    paths: Paths,
    binary: PathBuf,
    build: Build,
    key: ApiKey,
    quality: Quality,
    info: StreamInfo,
    sender: mpsc::Sender<Bytes>,
    cancel: CancellationToken,
    changed: impl Fn(State),
) -> Result<(), Error> {
    for attempt in 0..=3 {
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        let mut runtime = Runtime::new(&paths)?;

        let result = tokio::select! {
            _ = cancel.cancelled() => Err(Error::cancelled()),
            result = runtime.play(binary.clone(), &build, &key, &paths, quality, &info, &sender, &changed) => result,
        };
        runtime.close().await;
        match result {
            Ok(()) => return Ok(()),
            Err(error) if error.code == ErrorCode::ProcessFailed && !runtime.audio_started => {
                let Some(delay) = restart_delay(attempt) else {
                    return Err(error);
                };
                tokio::select! { _ = cancel.cancelled() => return Err(Error::cancelled()), _ = tokio::time::sleep(delay) => {} }
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("bounded attempts always return")
}
