//! Optional server-owned Soloist rendering. Catalog and queue authority stay in their owners.
mod binary;
mod capture;
mod config;
mod control;
mod prefs;
mod process;
mod runtime;
#[cfg(test)]
pub(crate) mod tests;
mod updater;

use crate::live_pcm::StreamInfo;
use axum::{
    Json, Router,
    body::Body,
    extract::{Extension, Path as RoutePath, State as RouteState},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use bytes::Bytes;
pub use config::PlaybackBackend;
use config::{ApiKey, Config, Quality};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::path::Path;
use std::{
    fs::{File, OpenOptions},
    path::PathBuf,
    sync::{
        Arc, Mutex as SyncMutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Mutex, mpsc},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NotInstalled,
    UnsupportedPlatform,
    InvalidExecutable,
    UnsupportedVersion,
    ApiKeyRequired,
    InvalidApiKey,
    PairingRequired,
    AuthenticationFailed,
    AccountRestricted,
    CaptureUnavailable,
    SinkStartupFailed,
    WebsocketFailed,
    ControlFailed,
    ProcessFailed,
    PlaybackStalled,
    TrackUnavailable,
    StreamInterrupted,
    UpdateFailed,
    Expired,
    Busy,
    ForwardingDisabled,
    Cancelled,
    StorageFailed,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
}
impl Error {
    pub fn new(code: ErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.to_owned(),
        }
    }
    fn io(_error: std::io::Error) -> Self {
        Self::new(
            ErrorCode::StorageFailed,
            "Soloist storage or capture I/O failed; check server directory permissions and available disk space",
        )
    }
    fn storage(_error: String) -> Self {
        Self::new(
            ErrorCode::StorageFailed,
            "Could not save private Soloist settings",
        )
    }
    fn expired() -> Self {
        Self::new(
            ErrorCode::Expired,
            "Soloist build expired. Automatic refresh will retry after download consent; pairing is preserved.",
        )
    }
    fn cancelled() -> Self {
        Self::new(
            ErrorCode::Cancelled,
            "Live stream was cancelled or superseded",
        )
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Error {}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match self.code {
            ErrorCode::Busy => StatusCode::CONFLICT,
            ErrorCode::InvalidApiKey | ErrorCode::InvalidExecutable => StatusCode::BAD_REQUEST,
            ErrorCode::Cancelled => StatusCode::GONE,
            _ => StatusCode::SERVICE_UNAVAILABLE,
        };
        (
            status,
            Json(serde_json::json!({ "error": self.message, "code": self.code })),
        )
            .into_response()
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    #[default]
    NotInstalled,
    Downloading,
    UnsupportedPlatform,
    ApiKeyRequired,
    PairingRequired,
    Ready,
    Playing,
    Paused,
    Buffering,
    Updating,
    Expired,
    Error,
}
#[derive(Clone)]
pub struct Paths {
    settings: PathBuf,
    key: PathBuf,
    pub session: PathBuf,
    pub cache: PathBuf,
    pub capture: PathBuf,
    install: PathBuf,
    lock: PathBuf,
}
impl Paths {
    fn application() -> Self {
        Self {
            settings: crate::storage::config_path("spotify-playback.json"),
            key: crate::storage::config_path("soloist/api-key"),
            session: crate::storage::config_path("soloist/session"),
            cache: crate::storage::cache_path("soloist/audio"),
            capture: crate::storage::cache_path("soloist/capture"),
            install: crate::storage::data_path("soloist/bin"),
            lock: crate::storage::data_path("soloist/session.lock"),
        }
    }
    fn prepare(&self) -> Result<(), Error> {
        for path in [
            self.key.parent().unwrap(),
            &self.session,
            &self.cache,
            &self.capture,
            &self.install,
            self.lock.parent().unwrap(),
        ] {
            capture::private_directory(path)?;
        }
        Ok(())
    }
    fn lock(&self) -> Result<File, Error> {
        self.prepare()?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&self.lock)
            .map_err(Error::io)?;
        file.try_lock().map_err(|_| {
            Error::new(
                ErrorCode::Busy,
                "Another Soloist session owns this server's data directory",
            )
        })?;
        Ok(file)
    }
    fn clear_runtime(&self) -> Result<(), Error> {
        // Only while holding the lease; never remove another process's state directory.
        for name in ["ws.addr", "ws.port"] {
            crate::service_auth::remove(self.session.join(name)).map_err(Error::io)?;
        }
        for entry in std::fs::read_dir(&self.capture).map_err(Error::io)? {
            let entry = entry.map_err(Error::io)?;
            let name = entry.file_name();
            if name
                .to_str()
                .is_some_and(|name| name.len() == 16 && name.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                if entry.file_type().map_err(Error::io)?.is_dir() {
                    std::fs::remove_dir_all(entry.path()).map_err(Error::io)?;
                } else {
                    std::fs::remove_file(entry.path()).map_err(Error::io)?;
                }
            }
        }
        Ok(())
    }
    fn accounts(&self) -> Vec<String> {
        std::fs::read_dir(self.session.join("settings/Users"))
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter_map(|entry| {
                entry
                    .file_name()
                    .to_str()?
                    .strip_suffix("-user")
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned)
            })
            .collect()
    }
    fn paired(&self) -> bool {
        !self.accounts().is_empty()
    }
    fn key(&self) -> Result<ApiKey, Error> {
        use std::io::Read;
        let file = File::open(&self.key).map_err(|_| {
            Error::new(
                ErrorCode::ApiKeyRequired,
                "Enter your personal Soloist API key on the server machine",
            )
        })?;
        let mut bytes = Vec::new();
        file.take(4097).read_to_end(&mut bytes).map_err(Error::io)?;
        ApiKey::parse(String::from_utf8(bytes).map_err(|_| {
            Error::new(
                ErrorCode::InvalidApiKey,
                "Stored Soloist API key is invalid",
            )
        })?)
        .map_err(|_| {
            Error::new(
                ErrorCode::InvalidApiKey,
                "Stored Soloist API key is invalid",
            )
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Preferred renderer; effective_renderer describes the current stream.
    pub backend: PlaybackBackend,
    pub preferred_quality: Quality,
    pub effective_renderer: Option<PlaybackBackend>,
    pub effective_quality: Option<Quality>,
    pub lossless_enabled: bool,
    pub download_consent: bool,
    pub state: State,
    pub build: Option<binary::Build>,
    pub needs_refresh: bool,
    pub api_key_present: bool,
    pub paired: bool,
    pub account_matches: Option<bool>,
    pub requested_quality: Quality,
    pub capture: capture::Capability,
    pub capture_format: crate::live_pcm::Format,
    pub source_format_verified: bool,
    pub forwarding_enabled: bool,
    pub automatic_updates_supported: bool,
    pub update_checks: bool,
    pub downloads_url: &'static str,
    pub error: Option<Error>,
}
struct Active {
    info: Option<StreamInfo>,
    endpoint: Option<String>,
    cancel: CancellationToken,
    receiver: Option<mpsc::Receiver<Bytes>>,
    sender: Option<mpsc::Sender<Bytes>>,
    task: Option<JoinHandle<()>>,
}

pub struct Manager {
    paths: Paths,
    config: RwLock<Config>,
    health: RwLock<(State, Option<binary::Build>, Option<Error>)>,
    expected_account: RwLock<Option<String>>,
    operation: Mutex<()>,
    maintenance: Mutex<()>,
    force_update: AtomicBool,
    effective_renderer: RwLock<Option<PlaybackBackend>>,
    capture_error: RwLock<Option<Error>>,
    active: SyncMutex<Option<Active>>,
    shutdown: CancellationToken,
    #[cfg(test)]
    test_ready: bool,
}

pub fn forwarding_enabled() -> bool {
    cfg!(all(
        ambra_development_build,
        debug_assertions,
        feature = "experimental-soloist-forwarding"
    )) && std::env::var("AMBRA_EXPERIMENTAL_SOLOIST_FORWARDING").as_deref() == Ok("1")
}
impl Manager {
    pub fn new() -> Arc<Self> {
        let paths = Paths::application();
        let (config, error) = match Config::load(&paths.settings) {
            Ok(config) => (config, None),
            Err(message) => (
                Config::default(),
                Some(Error::new(ErrorCode::StorageFailed, &message)),
            ),
        };
        let manager = Arc::new(Self {
            paths,
            config: RwLock::new(config),
            health: RwLock::new((State::NotInstalled, None, error)),
            expected_account: RwLock::new(None),
            operation: Mutex::new(()),
            maintenance: Mutex::new(()),
            force_update: AtomicBool::new(false),
            effective_renderer: RwLock::new(None),
            capture_error: RwLock::new(None),
            active: SyncMutex::new(None),
            shutdown: CancellationToken::new(),
            #[cfg(test)]
            test_ready: false,
        });
        let weak = Arc::downgrade(&manager);
        tokio::spawn(async move {
            loop {
                let Some(manager) = weak.upgrade() else {
                    return;
                };
                let cancel = manager.shutdown.clone();
                manager.refresh().await;
                drop(manager);
                tokio::select! { _ = cancel.cancelled() => return, _ = tokio::time::sleep(Duration::from_secs(30)) => {} }
            }
        });
        manager
    }
    fn config(&self) -> Config {
        self.config
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn lossless_enabled(&self) -> bool {
        self.config().lossless_enabled
    }
    pub fn report_renderer(&self, live: bool) {
        *self.effective_renderer.write().unwrap() = Some(if live {
            PlaybackBackend::Soloist
        } else {
            PlaybackBackend::Librespot
        });
    }
    pub fn clear_effective_renderer(&self) {
        *self.effective_renderer.write().unwrap() = None;
    }
    pub fn set_account(&self, account: Option<String>) {
        let changed = *self.expected_account.read().unwrap() != account;
        *self.expected_account.write().unwrap() = account;
        if changed {
            self.interrupt();
        }
    }
    fn account_matches(&self) -> Option<bool> {
        self.expected_account
            .read()
            .unwrap()
            .as_ref()
            .map(|expected| {
                let accounts = self.paths.accounts();
                accounts.len() == 1 && accounts[0] == *expected
            })
    }
    pub fn status(&self) -> Status {
        let config = self.config();
        let (mut state, build, mut error) = self.health.read().unwrap().clone();
        let mut capture = capture::capability();
        if let Some(capture_error) = self.capture_error.read().unwrap().clone() {
            capture.available = false;
            capture.reason = capture_error.message.clone();
            if error.is_none() {
                error = Some(capture_error);
            }
        }
        let paired = self.paths.paired();
        let api_key_present = self.paths.key().is_ok();
        if build
            .as_ref()
            .is_some_and(|build| build.expired(binary::now()))
        {
            state = State::Expired;
        } else if matches!(
            state,
            State::Ready | State::ApiKeyRequired | State::PairingRequired | State::Paused
        ) {
            if !api_key_present {
                state = State::ApiKeyRequired;
            } else if !paired || self.account_matches() == Some(false) {
                state = State::PairingRequired;
            }
        }
        let available = preferred_lossless(
            config.lossless_enabled,
            state,
            build.as_ref().is_some_and(|b| !b.expired(binary::now())),
            api_key_present,
            paired && self.account_matches() == Some(true),
            capture.available,
            forwarding_enabled(),
        );
        let preferred_quality = if available {
            Quality::Lossless
        } else {
            Quality::High
        };
        let effective_renderer = *self.effective_renderer.read().unwrap();
        Status {
            backend: if available {
                PlaybackBackend::Soloist
            } else {
                PlaybackBackend::Librespot
            },
            preferred_quality,
            effective_renderer,
            effective_quality: effective_renderer.map(|renderer| {
                if renderer == PlaybackBackend::Soloist {
                    Quality::Lossless
                } else {
                    Quality::High
                }
            }),
            lossless_enabled: config.lossless_enabled,
            download_consent: config.download_consent,
            state,
            needs_refresh: build
                .as_ref()
                .is_some_and(|b| b.needs_refresh(binary::now())),
            build,
            api_key_present,
            paired,
            account_matches: self.account_matches(),
            requested_quality: preferred_quality,
            capture,
            capture_format: Default::default(),
            source_format_verified: false,
            forwarding_enabled: forwarding_enabled(),
            automatic_updates_supported: true,
            update_checks: config.lossless_enabled && config.download_consent,
            downloads_url: binary::DOWNLOADS,
            error,
        }
    }
    pub fn readiness(&self) -> Result<(), Error> {
        #[cfg(test)]
        if self.test_ready && self.config().lossless_enabled {
            return Ok(());
        }
        if !self.config().lossless_enabled {
            return Err(Error::new(
                ErrorCode::NotInstalled,
                "Optional lossless support is disabled; Spotify uses High through librespot",
            ));
        }
        if self.shutdown.is_cancelled() {
            return Err(Error::cancelled());
        }
        if !forwarding_enabled() {
            return Err(Error::new(
                ErrorCode::ForwardingDisabled,
                "Spotify audio forwarding is disabled. It requires a debug development build, the experimental-soloist-forwarding feature, and explicit runtime opt-in; distributable builds cannot enable it.",
            ));
        }
        if crate::service_auth::disconnected("spotify") {
            return Err(Error::new(
                ErrorCode::AuthenticationFailed,
                "Connect Spotify through librespot first",
            ));
        }
        let status = self.status();
        if status.account_matches != Some(true) {
            return Err(Error::new(
                ErrorCode::AuthenticationFailed,
                "Soloist account does not match the Spotify account connected to Ambra",
            ));
        }
        if !status.api_key_present {
            self.paths.key()?;
        }
        // A prior runtime failure keeps preferred quality High. A new initialization
        // may probe the native backend again; only successful capture restores Lossless.
        let capture = capture::capability();
        if !capture.available {
            return Err(Error::new(ErrorCode::CaptureUnavailable, &capture.reason));
        }
        match status.state {
            State::Ready | State::Playing | State::Paused | State::Buffering | State::Updating
                if status
                    .build
                    .as_ref()
                    .is_some_and(|build| !build.expired(binary::now())) =>
            {
                Ok(())
            }
            State::ApiKeyRequired => Err(Error::new(
                ErrorCode::ApiKeyRequired,
                "Enter a personal Soloist API key on the server machine",
            )),
            State::PairingRequired => Err(Error::new(
                ErrorCode::PairingRequired,
                "Pair Soloist through the official Spotify application",
            )),
            State::Expired => Err(Error::expired()),
            _ => Err(status.error.unwrap_or_else(|| {
                Error::new(
                    ErrorCode::NotInstalled,
                    "Soloist is not ready; check Services on the server machine",
                )
            })),
        }
    }
    fn schedule_refresh(self: &Arc<Self>) {
        let manager = self.clone();
        tokio::spawn(async move {
            manager.refresh().await;
        });
    }
    async fn refresh(&self) {
        let Ok(_maintenance) = self.maintenance.try_lock() else {
            return;
        };
        let mut config = self.config();
        // Import the old configured executable once. Never grant network consent implicitly.
        if let Some(source) = &config.migration_executable {
            match updater::migrate(&self.paths.install, source).await {
                Ok(_) => {
                    let _operation = self.operation.lock().await;
                    let mut current = self.config();
                    if current.migration_executable == config.migration_executable {
                        current.migration_executable = None;
                        if let Err(error) = current.save(&self.paths.settings) {
                            self.health.write().unwrap().2 = Some(Error::storage(error));
                            return;
                        }
                        *self.config.write().unwrap() = current.clone();
                    }
                    config = current;
                }
                Err(error) => {
                    self.health.write().unwrap().2 = Some(error);
                }
            }
        }
        self.inspect_installed().await;
        let old = updater::installed(&self.paths.install);
        if config.lossless_enabled && config.download_consent {
            {
                let mut health = self.health.write().unwrap();
                if old.is_none() {
                    health.0 = State::Downloading;
                } else if health.0 == State::Ready {
                    health.0 = State::Updating;
                }
            }
            // No playback lock: updates install immutable digest paths; active renderers retain theirs.
            if let Err(error) = updater::maintain(
                &self.paths.install,
                true,
                self.force_update.swap(false, Ordering::AcqRel),
            )
            .await
            {
                self.health.write().unwrap().2 = Some(error);
            }
        }
        self.inspect_installed().await;
    }
    async fn inspect_installed(&self) {
        let result = async {
            let path = self.binary()?;
            let build = binary::inspect_status(&path).await?;
            prefs::render("", &build.version, Quality::Lossless)?;
            Ok::<_, Error>(build)
        }
        .await;
        let mut health = self.health.write().unwrap();
        match result {
            Ok(build) => {
                health.1 = Some(build);
                if !matches!(health.0, State::Playing | State::Buffering) {
                    health.0 = if self.paths.key().is_err() {
                        State::ApiKeyRequired
                    } else if !self.paths.paired() || self.account_matches() != Some(true) {
                        State::PairingRequired
                    } else {
                        State::Ready
                    };
                }
                health.2 = updater::diagnostic(&self.paths.install);
            }
            Err(error) => {
                if !matches!(health.0, State::Playing | State::Buffering) {
                    health.0 = state_for(&error);
                    if error.code != ErrorCode::Expired {
                        health.1 = None;
                    }
                }
                // Keep the more useful download diagnostic when nothing is installed.
                if health.2.is_none() || error.code != ErrorCode::NotInstalled {
                    health.2 = Some(error);
                }
            }
        }
    }
    fn binary(&self) -> Result<PathBuf, Error> {
        binary::locate(updater::installed(&self.paths.install).as_deref())
    }
    pub fn interrupt(&self) {
        if let Some(active) = self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .filter(|a| a.info.is_some())
        {
            active.cancel.cancel();
        }
    }
    pub async fn stop_playback(&self) {
        let _operation = self.operation.lock().await;
        let playback = self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| a.info.is_some());
        if playback {
            self.stop_locked().await;
        }
    }
    async fn stop_locked(&self) {
        let active = self.active.lock().unwrap().take();
        if let Some(mut active) = active {
            active.cancel.cancel();
            if let Some(mut task) = active.task.take()
                && tokio::time::timeout(Duration::from_secs(8), &mut task)
                    .await
                    .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
    }
    pub async fn stop(&self) {
        let _operation = self.operation.lock().await;
        self.stop_locked().await;
    }
    pub async fn retry_playback(&self) {
        self.stop_playback().await;
        // A failed capture remains unavailable until the capability probe retries.
        // Retry through the session uses librespot immediately; never relaunch the failed renderer.
        if self.health.read().unwrap().0 != State::Error {
            self.refresh().await;
        }
    }
    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        self.stop().await;
    }
    pub async fn pause(&self) {
        self.stop_playback().await;
        self.health.write().unwrap().0 = State::Paused;
    }

    pub async fn reserve(
        &self,
        track: &str,
        generation: u64,
        endpoint: &str,
        position: f64,
        duration: f64,
        restart: bool,
    ) -> Result<StreamInfo, Error> {
        if track.len() != 22
            || !track.bytes().all(|c| c.is_ascii_alphanumeric())
            || !position.is_finite()
            || position < 0.0
            || !duration.is_finite()
            || duration < 0.0
        {
            return Err(Error::new(
                ErrorCode::TrackUnavailable,
                "Invalid Spotify track or playback position",
            ));
        }
        let _operation = self.operation.lock().await;
        if !restart
            && let Some(active) = self.active.lock().unwrap().as_ref()
            && !active.cancel.is_cancelled()
            && active.endpoint.as_deref() == Some(endpoint)
            && let Some(info) = &active.info
            && info.track_id == track
            && info.generation == generation
        {
            return Ok(info.clone());
        }
        self.readiness()?;
        self.stop_locked().await;
        let info = StreamInfo {
            stream_id: crate::server_config::random_hex(16),
            track_id: track.to_owned(),
            generation,
            format: Default::default(),
            start_position_seconds: position,
            duration_seconds: duration,
            created_at_ms: binary::now() * 1000,
            requested_quality: "lossless".into(),
            source_format_verified: false,
        };
        let (sender, receiver) = mpsc::channel(8);
        *self.active.lock().unwrap() = Some(Active {
            info: Some(info.clone()),
            endpoint: Some(endpoint.to_owned()),
            cancel: CancellationToken::new(),
            receiver: Some(receiver),
            sender: Some(sender),
            task: None,
        });
        self.health.write().unwrap().0 = State::Buffering;
        Ok(info)
    }
    pub fn live_source(info: &StreamInfo) -> String {
        format!("/api/playback/live/{}", info.stream_id)
    }
    fn state_for_stream(&self, id: &str, state: State, error: Option<Error>) {
        if self
            .active
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|active| active.info.as_ref())
            .is_some_and(|info| info.stream_id == id)
        {
            if state == State::Playing {
                *self.capture_error.write().unwrap() = None;
            } else if let Some(error) = error.as_ref().filter(|error| {
                matches!(
                    error.code,
                    ErrorCode::CaptureUnavailable
                        | ErrorCode::SinkStartupFailed
                        | ErrorCode::PlaybackStalled
                )
            }) {
                *self.capture_error.write().unwrap() = Some(error.clone());
            }
            let mut health = self.health.write().unwrap();
            health.0 = state;
            health.2 = error;
        }
    }
    async fn open(
        self: &Arc<Self>,
        id: &str,
        caller: &crate::access::Caller,
    ) -> Result<LiveBody, Error> {
        self.readiness()?;
        let _operation = self.operation.lock().await;
        let binary = self.binary()?;
        let build = binary::inspect(&binary).await?;
        let key = self.paths.key()?;
        let (info, sender, receiver, cancel) = {
            let mut active = self.active.lock().unwrap();
            let active = active
                .as_mut()
                .filter(|active| {
                    !active.cancel.is_cancelled()
                        && active
                            .info
                            .as_ref()
                            .is_some_and(|info| info.stream_id == id)
                })
                .ok_or_else(Error::cancelled)?;
            if caller
                .client_id
                .as_deref()
                .is_some_and(|id| active.endpoint.as_deref() != Some(id))
            {
                return Err(Error::new(
                    ErrorCode::Cancelled,
                    "This stream belongs to another selected output",
                ));
            }
            let receiver = active.receiver.take().ok_or_else(|| {
                Error::new(ErrorCode::Busy, "Live streams permit only one consumer")
            })?;
            (
                active.info.clone().unwrap(),
                active.sender.take().unwrap(),
                receiver,
                active.cancel.clone(),
            )
        };
        let manager = self.clone();
        let paths = self.paths.clone();
        let quality = Quality::Lossless;
        let stream_id = info.stream_id.clone();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            let header = info.header().map(Bytes::from);
            if let Ok(header) = header {
                let _ = sender.send(header).await;
            }
            let result = runtime::stream(
                paths,
                binary,
                build,
                key,
                quality,
                info,
                sender.clone(),
                task_cancel.clone(),
                |state| manager.state_for_stream(&stream_id, state, None),
            )
            .await;
            let (state, error, frame) = match result {
                Ok(()) => (State::Ready, None, crate::live_pcm::end_frame()),
                Err(error) => (
                    state_for(&error),
                    Some(error.clone()),
                    crate::live_pcm::error_frame(&error.message),
                ),
            };
            if error
                .as_ref()
                .is_some_and(|error| error.code == ErrorCode::Expired)
            {
                manager.force_update.store(true, Ordering::Release);
            }
            manager.state_for_stream(&stream_id, state, error);
            let _ =
                tokio::time::timeout(Duration::from_secs(2), sender.send(Bytes::from(frame))).await;
        });
        if let Some(active) = self.active.lock().unwrap().as_mut() {
            active.task = Some(task);
        }
        Ok(LiveBody { receiver, cancel })
    }
    async fn configure(&self, change: SettingsChange) -> Result<(), Error> {
        let _operation = self.operation.lock().await;
        let mut config = self.config();
        let key = change.api_key.map(ApiKey::parse).transpose().map_err(|_| {
            Error::new(
                ErrorCode::InvalidApiKey,
                "Enter a valid personal Soloist API key",
            )
        })?;
        if key.is_some() && crate::service_auth::disconnected("spotify") {
            return Err(Error::new(
                ErrorCode::AuthenticationFailed,
                "Connect Spotify through librespot before configuring Soloist",
            ));
        }
        if let Some(enabled) = change.lossless_enabled {
            config.lossless_enabled = enabled;
        }
        if let Some(consent) = change.download_consent {
            config.download_consent = consent;
        }
        // Enabling lossless or granting consent never interrupts the current stream.
        if !config.lossless_enabled {
            self.stop_locked().await;
        }
        self.paths.prepare()?;
        if let Some(key) = key {
            crate::server_config::write_private(&self.paths.key, key.expose().as_bytes())
                .map_err(Error::storage)?;
        }
        config.save(&self.paths.settings).map_err(Error::storage)?;
        *self.config.write().unwrap() = config;
        if !matches!(
            self.health.read().unwrap().0,
            State::Playing | State::Buffering
        ) {
            self.health.write().unwrap().0 = State::NotInstalled;
        }
        Ok(())
    }
    async fn pair(self: &Arc<Self>) -> Result<(), Error> {
        let _operation = self.operation.lock().await;
        if crate::service_auth::disconnected("spotify")
            || self.expected_account.read().unwrap().is_none()
        {
            return Err(Error::new(
                ErrorCode::AuthenticationFailed,
                "Connect Spotify through librespot first, then pair the same account",
            ));
        }
        let binary = self.binary()?;
        binary::inspect(&binary).await?;
        let key = self.paths.key()?;
        self.stop_locked().await;
        let mut runtime = runtime::Runtime::new(&self.paths)?;
        let manager = self.clone();
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        *self.active.lock().unwrap() = Some(Active {
            info: None,
            endpoint: None,
            cancel,
            receiver: None,
            sender: None,
            task: None,
        });
        self.health.write().unwrap().0 = State::PairingRequired;
        let task = tokio::spawn(async move {
            let result = tokio::select! { _ = task_cancel.cancelled() => Err(Error::cancelled()), result = runtime.pair(&binary, &key, &manager.paths) => result };
            runtime.close().await;
            if task_cancel.is_cancelled() {
                return;
            }
            let result = result.and_then(|_| if manager.account_matches() == Some(false) { Err(Error::new(ErrorCode::AuthenticationFailed, "Soloist paired a different Spotify account. Reset pairing and select the account used by Ambra.")) } else { Ok(()) });
            let mut health = manager.health.write().unwrap();
            match result {
                Ok(()) => {
                    health.0 = State::Ready;
                    health.2 = None;
                }
                Err(error) => {
                    if error.code == ErrorCode::Expired {
                        manager.force_update.store(true, Ordering::Release);
                    }
                    health.0 = state_for(&error);
                    health.2 = Some(error);
                }
            }
        });
        if let Some(active) = self.active.lock().unwrap().as_mut() {
            active.task = Some(task);
        }
        Ok(())
    }
    async fn reset(&self, remove_key: bool) -> Result<(), Error> {
        let _operation = self.operation.lock().await;
        self.reset_locked(remove_key).await
    }
    async fn reset_locked(&self, remove_key: bool) -> Result<(), Error> {
        self.stop_locked().await;
        let _lease = self.paths.lock()?;
        match std::fs::remove_dir_all(&self.paths.session) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(Error::io(error));
            }
            _ => {}
        }
        if remove_key {
            crate::service_auth::remove(&self.paths.key).map_err(Error::io)?;
        }
        self.health.write().unwrap().0 = if remove_key {
            State::ApiKeyRequired
        } else {
            State::PairingRequired
        };
        Ok(())
    }
    pub async fn disconnect(&self) -> Result<(), Error> {
        self.interrupt();
        let _operation = self.operation.lock().await;
        self.reset_locked(true).await?;
        let mut config = self.config();
        config.lossless_enabled = false;
        config.save(&self.paths.settings).map_err(Error::storage)?;
        *self.config.write().unwrap() = config;
        self.set_account(None);
        Ok(())
    }
}
/// Capability policy; current streams remain pinned by the session until a playback boundary.
fn preferred_lossless(
    enabled: bool,
    state: State,
    valid_build: bool,
    key: bool,
    paired: bool,
    capture: bool,
    forwarding: bool,
) -> bool {
    enabled
        && valid_build
        && key
        && paired
        && capture
        && forwarding
        && matches!(
            state,
            State::Ready | State::Playing | State::Paused | State::Buffering | State::Updating
        )
}
fn state_for(error: &Error) -> State {
    match error.code {
        ErrorCode::NotInstalled => State::NotInstalled,
        ErrorCode::UnsupportedPlatform => State::UnsupportedPlatform,
        ErrorCode::ApiKeyRequired => State::ApiKeyRequired,
        ErrorCode::PairingRequired => State::PairingRequired,
        ErrorCode::Expired => State::Expired,
        ErrorCode::Cancelled => State::Ready,
        _ => State::Error,
    }
}

/// Dropping an HTTP body cancels its producer, even during a stalled FIFO read.
struct LiveBody {
    receiver: mpsc::Receiver<Bytes>,
    cancel: CancellationToken,
}
impl Stream for LiveBody {
    type Item = Result<Bytes, std::io::Error>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.receiver.poll_recv(cx).map(|item| item.map(Ok))
    }
}
impl Drop for LiveBody {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsChange {
    lossless_enabled: Option<bool>,
    download_consent: Option<bool>,
    api_key: Option<String>,
}

pub fn router<S: Clone + Send + Sync + 'static>(manager: Arc<Manager>) -> Router<S> {
    Router::new()
        .route("/api/spotify/playback/status", get(status))
        .route("/api/local/spotify/playback", get(settings).post(configure))
        .route("/api/local/spotify/soloist/pair", post(pair))
        .route("/api/local/spotify/soloist/reset", post(reset))
        .route("/api/local/spotify/soloist/sign-out", post(sign_out))
        .route("/api/local/spotify/soloist/check", post(check))
        .route(
            "/api/playback/live/{stream_id}",
            get(live).head(|| async { StatusCode::METHOD_NOT_ALLOWED }),
        )
        .with_state(manager)
}
async fn status(RouteState(manager): RouteState<Arc<Manager>>) -> Json<Status> {
    Json(manager.status())
}
async fn settings(RouteState(manager): RouteState<Arc<Manager>>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": manager.status() }))
}
async fn configure(
    RouteState(manager): RouteState<Arc<Manager>>,
    Json(change): Json<SettingsChange>,
) -> Result<Json<Status>, Error> {
    manager.configure(change).await?;
    manager.schedule_refresh();
    Ok(Json(manager.status()))
}
async fn pair(RouteState(manager): RouteState<Arc<Manager>>) -> Result<Json<Status>, Error> {
    manager.pair().await?;
    Ok(Json(manager.status()))
}
async fn reset(RouteState(manager): RouteState<Arc<Manager>>) -> Result<Json<Status>, Error> {
    manager.reset(false).await?;
    manager.schedule_refresh();
    Ok(Json(manager.status()))
}
async fn sign_out(RouteState(manager): RouteState<Arc<Manager>>) -> Result<Json<Status>, Error> {
    manager.disconnect().await?;
    Ok(Json(manager.status()))
}
async fn check(RouteState(manager): RouteState<Arc<Manager>>) -> Json<Status> {
    manager.schedule_refresh();
    Json(manager.status())
}
async fn live(
    RouteState(manager): RouteState<Arc<Manager>>,
    Extension(caller): Extension<crate::access::Caller>,
    RoutePath(id): RoutePath<String>,
    headers: HeaderMap,
) -> Result<Response, Error> {
    if headers.contains_key(header::RANGE) {
        return Ok((
            StatusCode::RANGE_NOT_SATISFIABLE,
            "Live PCM is not byte-seekable; seek through the shared session",
        )
            .into_response());
    }
    let body = manager.open(&id, &caller).await?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, crate::live_pcm::MIME)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Body::from_stream(body))
        .expect("static live response headers"))
}
