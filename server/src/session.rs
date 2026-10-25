//! The core: this server decides what plays, for every device that uses it.
//!
//! There is one session. Its queue is the shared `ambra.queue.v1` state, which only the core
//! writes: apps send the queue they want (based on the queue revision they saw), or ask for
//! next, previous and the like, and the core applies it and tells every app. The transport —
//! playing or paused, the position, the chosen output, what that output reports — lives here.
//!
//! The core plays through one output on one of the apps using this server: it tells that app
//! what to load and play (`endpoints.rs`), follows its reports, moves to the next song when
//! one ends, and counts each play in the listening history. Nothing about playback depends on
//! any app's window being open.

use std::{
    sync::{Arc, Mutex as SyncMutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, Notify, watch};

use crate::{endpoints::Endpoints, user_state::UserState};

const QUEUE_KEY: &str = "ambra.queue.v1";
const HISTORY_KEY: &str = "ambra.listening-history.v1";
/// The queue keeps recent plays to step back through; the listening history keeps them all.
const MAX_QUEUE_HISTORY: usize = 100;
/// Previous restarts the song once it has played this long, as players do.
const RESTART_AFTER_SECONDS: f64 = 3.0;
const TICK: Duration = Duration::from_millis(250);
const MAX_WAIT_SECONDS: u64 = 30;
const TRANSPORT_FILE: &str = "transport.v1.json";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub endpoint_id: String,
    pub device_id: String,
    pub endpoint_name: String,
    pub device_name: String,
}

/// What the chosen output has loaded, as the core asked for it.
#[derive(Clone, Debug, PartialEq)]
struct Loaded {
    endpoint_id: String,
    endpoint_instance: Option<String>,
    device_id: String,
    source: String,
    generation: u64,
}

#[derive(Default)]
struct Transport {
    playing: bool,
    position: f64,
    position_at: Option<Instant>,
    duration: f64,
    buffering: bool,
    error: Option<String>,
    audio_quality: Value,
    output: Option<Output>,
    /// Bumped to play the current song again from where `position` says, even if it's loaded.
    generation: u64,
    loaded: Option<Loaded>,
    queued_next: Option<Option<String>>,
    pending_play: Option<bool>,
    pending_seek: Option<f64>,
    /// The loaded song whose play has been counted, so each start counts once.
    counted: Option<(String, u64)>,
    /// Ignore reports sampled before the most recent load or transport command completed.
    report_after: Option<Instant>,
}

impl Transport {
    fn position_now(&self) -> f64 {
        let running = self.playing && !self.buffering && self.loaded.is_some();
        let elapsed = match (running, self.position_at) {
            (true, Some(at)) => at.elapsed().as_secs_f64().min(5.0),
            _ => 0.0,
        };
        let position = self.position + elapsed;
        if self.duration > 0.0 { position.min(self.duration) } else { position }
    }

    fn set_position(&mut self, position: f64) {
        self.position = position.max(0.0);
        self.position_at = Some(Instant::now());
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SavedTransport {
    output: Option<Output>,
    position: f64,
}

pub struct Core {
    state: Arc<UserState>,
    endpoints: Arc<Endpoints>,
    transport: SyncMutex<Transport>,
    /// Bumped whenever what apps show changes; apps wait on it.
    revision: watch::Sender<u64>,
    wake: Notify,
    /// One queue change at a time, so none is lost between reading and writing it.
    queue_lock: Mutex<()>,
    queue: SyncMutex<Option<Value>>,
    /// Commands and output acknowledgements commit together: a slow load must never
    /// overwrite a pause, seek or output change that arrived while it was in flight.
    operation: Mutex<()>,
    transport_path: std::path::PathBuf,
    instance_id: String,
}

type Shared = Arc<Core>;

// ---------- The queue (the `PersistedQueue` shape the apps save) ----------

fn queue_revision(queue: &Value) -> u64 {
    queue["revision"].as_u64().unwrap_or(0)
}

fn track_of<'a>(queue: &'a Value, item: &Value) -> Option<&'a Value> {
    let id = item["globalTrackId"].as_str()?;
    queue["tracks"].as_array()?.iter().find(|track| track["globalId"].as_str() == Some(id))
}

/// What an output plays for `track`: its stream (a DASH song as its HLS playlist), or a file path.
fn source_of(track: &Value) -> Option<String> {
    if track["provider"] == "local" && !track["audio"].as_str().is_some_and(|audio| audio.starts_with("http") || audio.starts_with("/api/")) {
        return track["providerTrackId"].as_str().map(str::to_owned);
    }
    let audio = track["audio"].as_str()?;
    if track["playbackKind"] == "dash" {
        let (path, query) = audio.split_once('?').map_or((audio, None), |(path, query)| (path, Some(query)));
        let path = path.strip_suffix("/manifest.mpd").map_or_else(|| path.to_owned(), |base| format!("{base}/playlist.m3u8"));
        return Some(query.map_or(path.clone(), |query| format!("{path}?{query}")));
    }
    Some(audio.to_owned())
}

fn current_and_next(queue: &Value) -> (Option<(Value, String)>, Option<String>) {
    let resolve = |item: &Value| track_of(queue, item).and_then(|track| source_of(track).map(|source| (track.clone(), source)));
    let current = (!queue["current"].is_null()).then(|| resolve(&queue["current"])).flatten();
    let next = queue["upcoming"].as_array().and_then(|upcoming| upcoming.first()).and_then(resolve)
        .filter(|(track, _)| !crate::service_auth::disconnected(track["provider"].as_str().unwrap_or("")))
        .map(|(_, source)| source);
    (current, next)
}

fn iso_now() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let (days, seconds) = ((now.as_secs() / 86_400) as i64, now.as_secs() % 86_400);
    // Civil date from days since 1970 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds / 3600,
        seconds % 3600 / 60,
        seconds % 60,
        now.subsec_millis()
    )
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn archived(item: &Value) -> Value {
    let mut entry = item.clone();
    entry["historyId"] = json!(format!("{}-{}", now_ms(), crate::server_config::random_hex(3)));
    entry["playedAt"] = json!(iso_now());
    entry
}

fn plain(entry: &Value) -> Value {
    json!({ "globalTrackId": entry["globalTrackId"], "source": entry["source"], "shufflePackageId": entry["shufflePackageId"] })
}

fn trim_history(queue: &mut Value) {
    if let Some(history) = queue["history"].as_array_mut()
        && history.len() > MAX_QUEUE_HISTORY
    {
        history.drain(..history.len() - MAX_QUEUE_HISTORY);
    }
}

/// The current song moves to the history and the next one plays. `false` if there is none.
fn advance(queue: &mut Value) -> bool {
    let has_next = queue["upcoming"].as_array().is_some_and(|upcoming| !upcoming.is_empty());
    if queue["current"].is_null() || !has_next {
        return false;
    }
    let current = queue["current"].take();
    let next = queue["upcoming"].as_array_mut().expect("checked above").remove(0);
    if let Some(history) = queue["history"].as_array_mut() {
        history.push(archived(&current));
    }
    queue["current"] = next;
    trim_history(queue);
    true
}

/// The last song ended: it joins the history and nothing is current.
fn finish(queue: &mut Value) {
    if advance(queue) || queue["current"].is_null() {
        return;
    }
    let current = queue["current"].take();
    if let Some(history) = queue["history"].as_array_mut() {
        history.push(archived(&current));
    }
    queue["upcoming"] = json!([]);
    trim_history(queue);
}

/// The previous song plays again, with the current one next. `false` if nothing was played.
fn rewind(queue: &mut Value) -> bool {
    let Some(previous) = queue["history"].as_array_mut().and_then(Vec::pop) else {
        return false;
    };
    let current = queue["current"].take();
    if !current.is_null()
        && let Some(upcoming) = queue["upcoming"].as_array_mut()
    {
        upcoming.insert(0, current);
    }
    queue["current"] = plain(&previous);
    true
}

fn empty_queue() -> Value {
    json!({ "version": 1, "history": [], "current": null, "upcoming": [], "tracks": [] })
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

impl Core {
    pub fn new(state: Arc<UserState>, endpoints: Arc<Endpoints>) -> Shared {
        let transport_path = state.directory().join(TRANSPORT_FILE);
        let saved: SavedTransport = std::fs::read(&transport_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let transport = Transport { output: saved.output, position: saved.position, ..Transport::default() };
        let core = Arc::new(Self {
            state,
            endpoints,
            transport: SyncMutex::new(transport),
            revision: watch::channel(1).0,
            wake: Notify::new(),
            queue_lock: Mutex::new(()),
            queue: SyncMutex::new(None),
            operation: Mutex::new(()),
            transport_path,
            instance_id: crate::server_config::random_hex(16),
        });
        tokio::spawn(drive(core.clone()));
        core
    }

    fn transport(&self) -> std::sync::MutexGuard<'_, Transport> {
        self.transport.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Something apps show changed; the driver also looks again at once.
    fn changed(&self) {
        self.revision.send_modify(|revision| *revision += 1);
        self.wake.notify_one();
    }

    pub(crate) fn save_transport(&self) {
        let saved = {
            let transport = self.transport();
            SavedTransport { output: transport.output.clone(), position: transport.position_now() }
        };
        if let Ok(bytes) = serde_json::to_vec(&saved) {
            let _ = crate::server_config::write_private(&self.transport_path, &bytes);
        }
    }

    /// The queue as last read; read again whenever the shared state changes.
    async fn queue(&self) -> Value {
        if let Some(queue) = self.queue.lock().ok().and_then(|queue| queue.clone()) {
            return queue;
        }
        let queue = self
            .state
            .value(QUEUE_KEY)
            .await
            .ok()
            .flatten()
            .and_then(|value| serde_json::from_str::<Value>(&value).ok())
            .filter(|queue| queue["version"] == 1)
            .unwrap_or_else(empty_queue);
        if let Ok(mut cached) = self.queue.lock() {
            *cached = Some(queue.clone());
        }
        queue
    }

    fn forget_queue(&self) {
        if let Ok(mut cached) = self.queue.lock() {
            *cached = None;
        }
    }

    /// Changes the queue, as the only writer of it. `change` returns whether it changed anything.
    async fn change_queue<T: Send + 'static>(
        &self,
        change: impl FnOnce(&mut Value) -> Result<(bool, T), String> + Send + 'static,
    ) -> Result<T, String> {
        let _guard = self.queue_lock.lock().await;
        let result = self
            .state
            .update(QUEUE_KEY, move |saved| {
                let mut queue = saved
                    .and_then(|saved| serde_json::from_str::<Value>(saved).ok())
                    .filter(|queue| queue["version"] == 1)
                    .unwrap_or_else(empty_queue);
                let (changed, result) = change(&mut queue)?;
                if !changed {
                    return Ok((saved.map(str::to_owned), result));
                }
                queue["revision"] = json!(queue_revision(&queue) + 1);
                Ok((Some(queue.to_string()), result))
            })
            .await;
        self.forget_queue();
        self.changed();
        result
    }

    async fn record_play(&self, track: Value) {
        let recorded = self
            .state
            .update(HISTORY_KEY, move |saved| {
                let mut history = saved
                    .and_then(|saved| serde_json::from_str::<Value>(saved).ok())
                    .filter(|history| history["version"] == 1 && history["entries"].is_array())
                    .unwrap_or_else(|| json!({ "version": 1, "entries": [] }));
                let entries = history["entries"].as_array_mut().expect("checked above");
                let id = track["globalId"].clone();
                let previous = entries.iter().position(|entry| entry["track"]["globalId"] == id).map(|index| entries.remove(index));
                // Entries from before play counts were kept count as one play.
                let plays = previous.map_or(0, |entry| entry["playCount"].as_u64().unwrap_or(1)) + 1;
                entries.insert(0, json!({ "track": track, "lastPlayedAt": now_ms(), "playCount": plays }));
                Ok((Some(history.to_string()), ()))
            })
            .await;
        if let Err(error) = recorded {
            eprintln!("Could not count a play: {error}");
        }
    }
}

// ---------- What apps see and send ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionView {
    instance_id: String,
    revision: u64,
    playing: bool,
    position_seconds: f64,
    /// When `position_seconds` was true, on the clock `/api/session/clock` reads, so an app
    /// can carry it forward from then rather than from when the view reached it.
    server_time_ms: f64,
    duration: f64,
    buffering: bool,
    error: Option<String>,
    audio_quality: Value,
    output: Option<Output>,
    output_online: bool,
    /// The queue revision this view goes with.
    queue_revision: u64,
    /// Left out when the app already has this revision: a long queue is large, and play,
    /// pause and buffering change the view far more often than the queue changes.
    #[serde(skip_serializing_if = "Option::is_none")]
    queue: Option<Value>,
}

/// `known_queue`: the queue revision the app already has, if any.
async fn view(core: &Core, known_queue: Option<u64>) -> SessionView {
    let queue = core.queue().await;
    let queue_revision = queue_revision(&queue);
    let output_endpoint = core.transport().output.as_ref().map(|output| output.endpoint_id.clone());
    let output_online = match &output_endpoint {
        Some(endpoint) => core.endpoints.online(endpoint).await,
        None => false,
    };
    let transport = core.transport();
    SessionView {
        instance_id: core.instance_id.clone(),
        revision: *core.revision.borrow(),
        playing: transport.playing,
        position_seconds: transport.position_now(),
        server_time_ms: server_time_ms(),
        duration: transport.duration,
        buffering: transport.buffering,
        error: transport.error.clone(),
        audio_quality: transport.audio_quality.clone(),
        output: transport.output.clone(),
        output_online,
        queue: (known_queue != Some(queue_revision)).then_some(queue),
        queue_revision,
    }
}

/// Milliseconds on a clock that only moves forward, from an arbitrary start in this process.
fn server_time_ms() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// Answered at once, so an app can time the round trip and line its clock up with this one.
async fn clock() -> Json<Value> {
    Json(json!({ "serverTimeMs": server_time_ms() }))
}

pub fn router<S: Clone + Send + Sync + 'static>(core: Shared) -> Router<S> {
    Router::new()
        .route("/api/session", get(read))
        .route("/api/session/clock", get(clock))
        .route("/api/session/queue", post(set_queue))
        .route("/api/session/command", post(command))
        .with_state(core)
}

#[derive(Deserialize)]
struct ReadQuery {
    since: Option<u64>,
    wait: Option<u64>,
    /// The queue revision the app has; the queue is sent only when it's different.
    queue: Option<u64>,
}

async fn read(State(core): State<Shared>, Query(query): Query<ReadQuery>) -> Json<SessionView> {
    if let (Some(since), Some(wait)) = (query.since, query.wait.filter(|wait| *wait > 0)) {
        let mut revision = core.revision.subscribe();
        let _ = tokio::time::timeout(Duration::from_secs(wait.min(MAX_WAIT_SECONDS)), revision.wait_for(|current| *current != since)).await;
    }
    Json(view(&core, query.queue).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueChange {
    /// The queue revision the app changed; refused if the queue has moved on since.
    base: u64,
    queue: Value,
    /// Then plays this song, the new current one, from the start.
    play_track_id: Option<String>,
}

async fn set_queue(State(core): State<Shared>, Json(change): Json<QueueChange>) -> Response {
    let _operation = core.operation.lock().await;
    if change.queue["version"] != 1 {
        return error(StatusCode::BAD_REQUEST, "Unsupported queue");
    }
    let base = change.base;
    let mut queue = change.queue;
    let applied = core
        .change_queue(move |saved| {
            let current = queue_revision(saved);
            if current != base {
                return Ok((false, Err(current)));
            }
            queue["revision"] = json!(current);
            *saved = queue;
            Ok((true, Ok(())))
        })
        .await;
    match applied {
        Ok(Ok(())) => {}
        Ok(Err(current)) => {
            return (StatusCode::CONFLICT, Json(json!({ "error": "The queue changed meanwhile", "queueRevision": current, "session": view(&core, None).await }))).into_response();
        }
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    }
    if let Some(track_id) = change.play_track_id {
        play_track(&core, &track_id).await;
    }
    Json(view(&core, None).await).into_response()
}

async fn play_track(core: &Core, track_id: &str) {
    let queue = core.queue().await;
    let is_current = queue["current"]["globalTrackId"].as_str() == Some(track_id);
    let mut transport = core.transport();
    if is_current {
        transport.generation += 1;
        transport.set_position(0.0);
        transport.playing = true;
        transport.error = None;
    }
    drop(transport);
    core.changed();
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum Command {
    PlayTrack { #[serde(rename = "trackId")] track_id: String },
    Play,
    Pause,
    Toggle,
    Seek { #[serde(rename = "positionSeconds")] position_seconds: f64 },
    Next,
    Previous,
    Stop,
    Output { output: Option<Output> },
    Volume { volume: f64 },
}

async fn command(State(core): State<Shared>, Query(query): Query<ReadQuery>, Json(command): Json<Command>) -> Response {
    let _operation = core.operation.lock().await;
    let result: Result<(), String> = match command {
        Command::PlayTrack { track_id } => {
            play_track(&core, &track_id).await;
            Ok(())
        }
        Command::Play | Command::Pause | Command::Toggle => {
            let mut transport = core.transport();
            let playing = match command {
                Command::Play => true,
                Command::Pause => false,
                _ => !transport.playing,
            };
            let position = transport.position_now();
            transport.set_position(position);
            transport.playing = playing;
            transport.pending_play = Some(playing);
            if playing {
                transport.error = None;
            }
            drop(transport);
            core.changed();
            Ok(())
        }
        Command::Seek { position_seconds } if position_seconds.is_finite() && position_seconds >= 0.0 => {
            let mut transport = core.transport();
            transport.set_position(position_seconds);
            transport.pending_seek = Some(position_seconds);
            drop(transport);
            core.changed();
            Ok(())
        }
        Command::Seek { .. } => Err("Invalid position".into()),
        Command::Next => skip(&core, true).await,
        Command::Previous => {
            // Past the first few seconds it starts the song over; before that it goes back one,
            // or starts over when nothing played before it.
            let restart = core.transport().position_now() > RESTART_AFTER_SECONDS;
            let rewound = !restart && core.change_queue(|queue| { let moved = rewind(queue); Ok((moved, moved)) }).await.unwrap_or(false);
            let mut transport = core.transport();
            transport.set_position(0.0);
            if !rewound {
                transport.pending_seek = Some(0.0);
            } else {
                transport.generation += 1;
            }
            drop(transport);
            core.changed();
            Ok(())
        }
        Command::Stop => {
            let mut transport = core.transport();
            transport.playing = false;
            transport.pending_play = Some(false);
            transport.set_position(0.0);
            drop(transport);
            core.changed();
            Ok(())
        }
        Command::Output { output } => {
            let previous = {
                let mut transport = core.transport();
                let previous = transport.output.clone();
                if previous != output {
                    transport.position = transport.position_now();
                    transport.position_at = Some(Instant::now());
                    transport.output = output.clone();
                    transport.loaded = None;
                    transport.queued_next = None;
                    transport.error = None;
                }
                previous
            };
            // The song moves: the old output stops, and the driver loads it on the new one.
            if let Some(previous) = previous.filter(|previous| Some(previous) != output.as_ref()) {
                let _ = core.endpoints.call(&previous.endpoint_id, "pause_native_audio", json!({})).await;
            }
            core.save_transport();
            core.changed();
            Ok(())
        }
        Command::Volume { volume } => {
            let output = core.transport().output.clone();
            match output {
                Some(output) => core.endpoints.call(&output.endpoint_id, "set_native_audio_volume", json!({ "volume": volume })).await.map(|_| ()),
                None => Err("Choose an output first".into()),
            }
        }
    };
    match result {
        Ok(()) => Json(view(&core, query.queue).await).into_response(),
        Err(message) => error(StatusCode::BAD_REQUEST, message),
    }
}

/// Next: the queue moves on and the new song plays from its start.
async fn skip(core: &Core, forward: bool) -> Result<(), String> {
    let advanced = core.change_queue(move |queue| {
        let moved = if forward { advance(queue) } else { rewind(queue) };
        Ok((moved, moved))
    }).await?;
    if advanced {
        let mut transport = core.transport();
        transport.generation += 1;
        transport.set_position(0.0);
        drop(transport);
        core.changed();
    }
    Ok(())
}

// ---------- Playing on the chosen output ----------

async fn drive(core: Shared) {
    let mut state_changes = core.state.subscribe();
    let mut saved_at = Instant::now();
    loop {
        tokio::select! {
            _ = core.wake.notified() => {}
            _ = core.endpoints.reported() => {}
            changed = state_changes.changed() => {
                if changed.is_err() { return; }
                core.forget_queue();
            }
            _ = tokio::time::sleep(TICK) => {}
        }
        if let Err(message) = step(&core).await {
            let mut transport = core.transport();
            if transport.error.as_deref() != Some(&message) {
                transport.error = Some(message);
                drop(transport);
                core.changed();
            }
        }
        if saved_at.elapsed() >= Duration::from_secs(5) {
            core.save_transport();
            saved_at = Instant::now();
        }
    }
}

/// One look at the session and the output: loads, play, pause, seeks, and moving on.
async fn step(core: &Core) -> Result<(), String> {
    let _operation = core.operation.lock().await;
    let queue = core.queue().await;
    let (current, mut next) = current_and_next(&queue);
    let Some(output) = core.transport().output.clone() else {
        return Ok(());
    };
    let endpoint = output.endpoint_id.clone();

    let Some((track, source)) = current else {
        // Nothing to play: the output stops if it was playing something.
        let was_loaded = core.transport().loaded.take().is_some();
        if was_loaded {
            let _ = core.endpoints.call(&endpoint, "pause_native_audio", json!({})).await;
            let mut transport = core.transport();
            transport.playing = false;
            transport.set_position(0.0);
            transport.duration = 0.0;
            drop(transport);
            core.changed();
        }
        return Ok(());
    };
    if crate::service_auth::disconnected(track["provider"].as_str().unwrap_or("")) {
        let was_loaded = {
            let mut transport = core.transport();
            let loaded = transport.loaded.take().is_some();
            transport.playing = false;
            transport.buffering = false;
            transport.queued_next = None;
            loaded
        };
        if was_loaded {
            let _ = core.endpoints.call(&endpoint, "pause_native_audio", json!({})).await;
            core.changed();
        }
        return Err("This song's service is disconnected. Reconnect it or replace the song with Improve Playlist.".into());
    }
    // Identical consecutive sources cannot be distinguished by a source-only engine report.
    // Let the first finish, then explicitly load the next occurrence.
    if next.as_deref() == Some(source.as_str()) { next = None; }
    let Some((status, reported_at, _, endpoint_instance)) = core.endpoints.status(&endpoint).await else {
        // Keep the last confirmed position and play intent, not a clock that keeps
        // advancing while the output app is gone. The server itself is still online.
        core.transport().buffering = true;
        return Err(format!("Audio output {} is offline", output.endpoint_name));
    };

    let (wanted, needs_device, position, autoplay, needs_load) = {
        let transport = core.transport();
        // Older apps do not send instanceId. A fresh, idle, empty engine also proves
        // the cached load is gone; never mistake an old report or a load error for this.
        let empty_engine = endpoint_instance.is_none()
            && transport.loaded.is_some()
            && transport.report_after.is_none_or(|after| reported_at >= after)
            && status.get("currentSource").is_some_and(Value::is_null)
            && status["buffering"] == false
            && status["ended"] != true
            && status["error"].is_null();
        let wanted = Loaded { endpoint_id: endpoint.clone(), endpoint_instance: endpoint_instance.clone(), device_id: output.device_id.clone(), source: source.clone(), generation: transport.generation };
        let needs_device = empty_engine || transport.loaded.as_ref().is_none_or(|loaded| loaded.endpoint_id != endpoint || loaded.endpoint_instance != endpoint_instance || loaded.device_id != output.device_id);
        // A different song always starts at zero; a changed output resumes the same song.
        let changed_song = transport.loaded.as_ref().is_some_and(|loaded| loaded.source != source);
        let restarted = transport.loaded.as_ref().is_some_and(|loaded| loaded.endpoint_instance != endpoint_instance);
        let needs_load = empty_engine || transport.loaded.as_ref() != Some(&wanted);
        (wanted, needs_device, if changed_song { 0.0 } else if restarted || empty_engine { transport.position } else { transport.position_now() }, transport.playing, needs_load)
    };
    if needs_load {
        if needs_device {
            core.endpoints.call(&endpoint, "select_native_audio_device", json!({ "deviceId": output.device_id })).await?;
        }
        let duration = track["durationSeconds"].as_f64().unwrap_or(0.0);
        core.endpoints
            .call(&endpoint, "load_native_audio", json!({ "source": source, "nextSource": next, "positionSeconds": position, "autoplay": autoplay }))
            .await?;
        let mut transport = core.transport();
        transport.loaded = Some(wanted);
        transport.queued_next = Some(next.clone());
        transport.pending_play = None;
        transport.pending_seek = None;
        transport.duration = duration;
        transport.buffering = autoplay;
        transport.error = None;
        transport.set_position(position);
        transport.report_after = Some(Instant::now());
        drop(transport);
        core.changed();
        return Ok(());
    }

    let (pending_play, pending_seek, queued_next) = {
        let mut transport = core.transport();
        (transport.pending_play.take(), transport.pending_seek.take(), transport.queued_next.clone())
    };
    if let Some(seek) = pending_seek {
        core.endpoints.call(&endpoint, "seek_native_audio", json!({ "positionSeconds": seek })).await?;
        if core.transport().playing {
            core.endpoints.call(&endpoint, "play_native_audio", json!({})).await?;
        }
    }
    if let Some(playing) = pending_play {
        let command = if playing { "play_native_audio" } else { "pause_native_audio" };
        core.endpoints.call(&endpoint, command, json!({})).await?;
    }
    if pending_seek.is_some() || pending_play.is_some() {
        core.transport().report_after = Some(Instant::now());
    }
    if queued_next.as_ref() != Some(&next) {
        core.endpoints.call(&endpoint, "queue_native_audio", json!({ "source": next, "expectedSource": source })).await?;
        core.transport().queued_next = Some(next.clone());
    }

    let Some((status, reported_at, sampled_at, reported_instance)) = core.endpoints.status(&endpoint).await else {
        return Ok(());
    };
    // A restart during an awaited command needs a new load, not the old engine's reports.
    if reported_instance != endpoint_instance {
        return Ok(());
    }
    if core.transport().report_after.is_some_and(|after| reported_at < after) {
        return Ok(());
    }
    let playing_source = status["currentSource"].as_str().map(str::to_owned);
    // The output moved on to the queued song by itself, without a gap.
    if playing_source.is_some() && playing_source == next && next.as_deref() != Some(source.as_str()) {
        core.change_queue(|queue| Ok((advance(queue), ()))).await?;
        let mut transport = core.transport();
        if let Some(loaded) = transport.loaded.as_mut() {
            loaded.source = next.clone().unwrap_or_default();
        }
        transport.queued_next = None;
        transport.set_position(status["currentTime"].as_f64().unwrap_or(0.0));
        drop(transport);
        core.changed();
        return Ok(());
    }
    if playing_source.as_deref() != Some(source.as_str()) {
        return Ok(());
    }

    let ended = status["ended"].as_bool().unwrap_or(false);
    let engine_playing = status["isPlaying"].as_bool().unwrap_or(false);
    let buffering = status["buffering"].as_bool().unwrap_or(false);
    let count = {
        let mut transport = core.transport();
        let before = (transport.buffering, transport.error.clone(), transport.duration, transport.audio_quality.clone());
        transport.position = status["currentTime"].as_f64().unwrap_or(transport.position);
        transport.position_at = Some(sampled_at);
        if let Some(duration) = status["duration"].as_f64().filter(|duration| *duration > 0.0) {
            transport.duration = duration;
        }
        transport.buffering = buffering && transport.playing;
        transport.error = status["error"].as_str().map(str::to_owned);
        transport.audio_quality = status["audioQuality"].clone();
        let after = (transport.buffering, transport.error.clone(), transport.duration, transport.audio_quality.clone());
        let generation = transport.generation;
        let count = engine_playing && !buffering && transport.counted.as_ref() != Some(&(source.clone(), generation));
        if count {
            transport.counted = Some((source.clone(), generation));
        }
        if before != after {
            drop(transport);
            core.changed();
        }
        count
    };
    if count {
        core.record_play(track.clone()).await;
    }
    if ended {
        // The song finished with nothing queued behind it in the engine: move on, or stop.
        let moved = core.change_queue(|queue| {
            let moved = advance(queue);
            if !moved {
                finish(queue);
            }
            Ok((true, moved))
        }).await?;
        let mut transport = core.transport();
        transport.set_position(0.0);
        if !moved {
            transport.playing = false;
            transport.loaded = None;
        } else {
            transport.generation += 1;
        }
        drop(transport);
        core.changed();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue() -> Value {
        json!({
            "version": 1,
            "history": [{ "globalTrackId": "a", "source": { "kind": "library", "id": "library", "entryId": 1 }, "shufflePackageId": null, "historyId": "h1", "playedAt": "2026-01-01T00:00:00.000Z" }],
            "current": { "globalTrackId": "b", "source": { "kind": "library", "id": "library", "entryId": 2 }, "shufflePackageId": null },
            "upcoming": [{ "globalTrackId": "c", "source": { "kind": "library", "id": "library", "entryId": 3 }, "shufflePackageId": null }],
            "tracks": [
                { "globalId": "a", "audio": "http://h:1/api/a", "playbackKind": "direct", "provider": "qobuz" },
                { "globalId": "b", "audio": "http://h:1/api/providers/tidal/tracks/2/manifest.mpd?q=1", "playbackKind": "dash", "provider": "tidal" },
                { "globalId": "c", "audio": "C:/Music/c.flac", "providerTrackId": "C:/Music/c.flac", "playbackKind": "direct", "provider": "local" },
            ],
        })
    }

    #[test]
    fn sources_are_what_outputs_play() {
        let (current, next) = current_and_next(&queue());
        assert_eq!(current.unwrap().1, "http://h:1/api/providers/tidal/tracks/2/playlist.m3u8?q=1");
        assert_eq!(next.unwrap(), "C:/Music/c.flac");
        assert_eq!(source_of(&json!({ "provider": "local", "providerTrackId": "hash.flac", "audio": "/api/music/local/files/hash.flac", "playbackKind": "direct" })).as_deref(), Some("/api/music/local/files/hash.flac"));
    }

    #[test]
    fn next_and_previous_move_through_the_queue() {
        let mut q = queue();
        assert!(advance(&mut q));
        assert_eq!(q["current"]["globalTrackId"], "c");
        assert_eq!(q["history"].as_array().unwrap().len(), 2);
        assert_eq!(q["history"][1]["globalTrackId"], "b");
        assert!(q["history"][1]["playedAt"].as_str().unwrap().ends_with('Z'));
        assert!(!advance(&mut q), "nothing after the last song");
        assert!(rewind(&mut q));
        assert_eq!(q["current"]["globalTrackId"], "b");
        assert_eq!(q["upcoming"][0]["globalTrackId"], "c");
        assert!(q["current"].get("historyId").is_none());
    }

    #[test]
    fn the_last_song_ending_leaves_nothing_current() {
        let mut q = queue();
        advance(&mut q);
        finish(&mut q);
        assert!(q["current"].is_null());
        assert_eq!(q["history"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn dates_are_iso_8601() {
        let date = iso_now();
        assert_eq!(date.len(), 24);
        assert!(date.starts_with("20") && date.contains('T') && date.ends_with('Z'));
    }
}

#[cfg(test)]
mod driver_tests {
    use super::*;
    use std::collections::HashMap;

    struct Harness {
        base: String,
        http: reqwest::Client,
        state: Arc<UserState>,
        core: Shared,
        instance: Arc<SyncMutex<Option<String>>>,
        /// Every command the simulated output app received, in order.
        received: Arc<SyncMutex<Vec<(String, Value)>>>,
        status: Arc<SyncMutex<Value>>,
        /// One report at a time, as the real output app sends them, so none arrives out of order.
        sending: Arc<Mutex<()>>,
    }

    impl Harness {
        async fn start() -> Self {
            let directory = std::env::temp_dir().join(format!("ambra-core-{}-{}", std::process::id(), crate::server_config::random_hex(4)));
            let state = Arc::new(UserState::at(directory.join("user-state.v1.json")));
            let endpoints = Arc::new(Endpoints::default());
            let core = Core::new(state.clone(), endpoints.clone());
            let app: Router = Router::new()
                .merge(crate::endpoints::router(endpoints.clone()))
                .merge(router(core.clone()));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let harness = Self { base, http: reqwest::Client::new(), state, core, instance: Arc::default(), received: Arc::default(), status: Arc::default(), sending: Arc::default() };
            harness.report(json!({})).await;
            harness.serve_commands();
            harness
        }

        async fn report(&self, status: Value) {
            let _sending = self.sending.lock().await;
            *self.status.lock().unwrap() = status.clone();
            let instance = self.instance.lock().unwrap().clone();
            self.http.post(format!("{}/api/endpoints/desk/presence", self.base))
                .json(&json!({ "name": "Desk", "instanceId": instance, "devices": [{ "id": "spk", "name": "Speakers" }], "status": status }))
                .send().await.unwrap();
        }

        /// The output app: answers every command at once, like an idle engine would.
        fn serve_commands(&self) {
            let (base, http, status, instance, sending) = (self.base.clone(), self.http.clone(), self.status.clone(), self.instance.clone(), self.sending.clone());
            // A real output reports continuously, including after a command acknowledgement.
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let _sending = sending.lock().await;
                    let status = status.lock().unwrap().clone();
                    let instance = instance.lock().unwrap().clone();
                    let _ = http.post(format!("{base}/api/endpoints/desk/presence"))
                        .json(&json!({ "name": "Desk", "instanceId": instance, "status": status })).send().await;
                }
            });
            let (base, http, received, status) = (self.base.clone(), self.http.clone(), self.received.clone(), self.status.clone());
            tokio::spawn(async move {
                loop {
                    let Ok(response) = http.get(format!("{base}/api/endpoints/desk/commands?wait=5")).send().await else { continue };
                    for command in response.json::<Vec<Value>>().await.unwrap_or_default() {
                        received.lock().unwrap().push((command["command"].as_str().unwrap().to_owned(), command["args"].clone()));
                        if command["command"] == "load_native_audio" {
                            *status.lock().unwrap() = json!({
                                "currentSource": command["args"]["source"],
                                "currentTime": command["args"]["positionSeconds"],
                                "buffering": true, "ended": false, "error": null
                            });
                        }
                        http.post(format!("{base}/api/endpoints/desk/results"))
                            .json(&json!({ "id": command["id"], "ok": true, "value": null }))
                            .send().await.unwrap();
                    }
                }
            });
        }

        async fn post(&self, path: &str, body: Value) -> Value {
            self.http.post(format!("{}{path}", self.base)).json(&body).send().await.unwrap().json().await.unwrap()
        }

        async fn queue(&self) -> Value {
            serde_json::from_str(&self.state.value(QUEUE_KEY).await.unwrap().unwrap()).unwrap()
        }

        async fn history(&self) -> Option<String> {
            self.state.value(HISTORY_KEY).await.unwrap()
        }

        async fn wait_for_command(&self, command: &str) {
            for _ in 0..80 {
                if self.received.lock().unwrap().iter().any(|(received, _)| received == command) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("timed out waiting for {command}: {:?}", self.received.lock().unwrap());
        }
    }

    macro_rules! eventually {
        ($what:expr, $done:expr) => {{
            let mut done = false;
            for _ in 0..80 {
                if $done {
                    done = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(done, "timed out waiting for {}", $what);
        }};
    }

    fn item(id: &str) -> Value {
        json!({ "globalTrackId": id, "source": { "kind": "library", "id": "library", "entryId": 1 }, "shufflePackageId": null })
    }

    fn track(id: &str) -> Value {
        json!({ "globalId": id, "providerTrackId": id, "audio": format!("http://127.0.0.1:38147/api/providers/qobuz/tracks/{id}/stream"), "cover": "", "name": id, "album": "A", "artist": "B", "provider": "qobuz", "playbackKind": "direct", "durationSeconds": 200, "artists": [], "albumArtists": [] })
    }

    fn source(id: &str) -> String {
        format!("http://127.0.0.1:38147/api/providers/qobuz/tracks/{id}/stream")
    }

    async fn check_reopened_output(with_instance: bool, paused: bool) {
        let h = Harness::start().await;
        if with_instance {
            *h.instance.lock().unwrap() = Some("first-process".into());
            h.report(json!({})).await;
        }
        h.post("/api/session/command", json!({ "action": "output", "output": { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" } })).await;
        let queued = json!({ "version": 1, "history": [], "current": item("a"), "upcoming": [item("b")], "tracks": [track("a"), track("b")] });
        h.post("/api/session/queue", json!({ "base": 0, "queue": queued, "playTrackId": "a" })).await;
        h.wait_for_command("load_native_audio").await;
        h.report(json!({ "currentSource": source("a"), "currentTime": 64.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        eventually!("mid-song report", h.core.transport().position == 64.0);
        eventually!("the play to count", h.history().await.is_some());
        if paused {
            h.post("/api/session/command", json!({ "action": "pause" })).await;
            h.wait_for_command("pause_native_audio").await;
            // As a real engine does: it reports where it paused, which the core then holds.
            h.report(json!({ "currentSource": source("a"), "currentTime": 64.5, "duration": 200.0, "isPlaying": false, "buffering": false, "ended": false })).await;
            eventually!("the paused position", h.core.transport().position == 64.5);
        }
        let queue = h.queue().await;
        let history = h.history().await;
        let generation = h.core.transport().generation;
        let resume_position = {
            let _operation = h.core.operation.lock().await;
            let mut transport = h.core.transport();
            // The state left while the app was absent; reopening must recover without
            // a playTrack command, queue mutation, or another listening-history entry.
            transport.error = Some("Desk is offline".into());
            transport.buffering = true;
            if with_instance {
                *h.instance.lock().unwrap() = Some("reopened-process".into());
            }
            *h.status.lock().unwrap() = json!({ "currentSource": null, "currentTime": 0.0, "isPlaying": false, "buffering": false, "ended": false, "error": null });
            h.received.lock().unwrap().clear();
            transport.position
        };
        h.wait_for_command("load_native_audio").await;
        eventually!("offline error to clear", h.core.transport().error.is_none());
        {
            let received = h.received.lock().unwrap();
            let loads: Vec<_> = received.iter().filter(|(command, _)| command == "load_native_audio").collect();
            assert_eq!(loads.len(), 1);
            let args = &loads[0].1;
            assert_eq!(args["source"], source("a"));
            assert_eq!(args["nextSource"], source("b"));
            assert_eq!(args["positionSeconds"], resume_position);
            assert_eq!(args["autoplay"], !paused);
        }
        h.report(json!({ "currentSource": source("a"), "currentTime": 65.0, "duration": 200.0, "isPlaying": !paused, "buffering": false, "ended": false })).await;
        eventually!("resumed report", h.core.transport().position == 65.0);
        assert_eq!(h.core.transport().generation, generation);
        assert_eq!(h.queue().await, queue);
        assert_eq!(h.history().await, history);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reopening_the_output_resumes_the_current_song_and_clears_offline_error() {
        check_reopened_output(true, false).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reopening_a_legacy_output_keeps_a_paused_song_paused() {
        check_reopened_output(false, true).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_core_plays_the_queue_on_its_output_and_moves_on_by_itself() {
        let h = Harness::start().await;
        h.post("/api/session/command", json!({ "action": "output", "output": { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" } })).await;
        let queued = json!({ "version": 1, "history": [], "current": item("a"), "upcoming": [item("b")], "tracks": [track("a"), track("b")] });
        let view = h.post("/api/session/queue", json!({ "base": 0, "queue": queued, "playTrackId": "a" })).await;
        assert_eq!(view["playing"], true);

        // The core picks the output and loads the song with the next one ready behind it.
        h.wait_for_command("load_native_audio").await;
        {
            let received = h.received.lock().unwrap();
            assert_eq!(received[0], ("select_native_audio_device".into(), json!({ "deviceId": "spk" })));
            let load = &received.iter().find(|(command, _)| command == "load_native_audio").unwrap().1;
            assert_eq!(load["source"], source("a"));
            assert_eq!(load["nextSource"], source("b"));
            assert_eq!(load["autoplay"], true);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let loads = h.received.lock().unwrap().iter().filter(|(command, _)| command == "load_native_audio").count();
        assert_eq!(loads, 1, "loaded once, already playing");

        // Playing is counted in the listening history.
        h.report(json!({ "currentSource": source("a"), "currentTime": 3.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        eventually!("the play to count", h.history().await.is_some_and(|history| history.contains("\"a\"")));

        // The output moves to the queued song without a gap; the queue follows.
        h.report(json!({ "currentSource": source("b"), "currentTime": 0.5, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        eventually!("the queue to advance", h.queue().await["current"]["globalTrackId"] == "b");
        assert_eq!(h.queue().await["history"][0]["globalTrackId"], "a");

        // Pausing reaches the output, and every app sees it.
        let paused = h.post("/api/session/command", json!({ "action": "pause" })).await;
        assert_eq!(paused["playing"], false);
        h.wait_for_command("pause_native_audio").await;

        // The last song ends: nothing is current and playback stops.
        h.post("/api/session/command", json!({ "action": "play" })).await;
        h.report(json!({ "currentSource": source("b"), "currentTime": 200.0, "duration": 200.0, "isPlaying": false, "buffering": false, "ended": true })).await;
        eventually!("the queue to finish", h.queue().await["current"].is_null());
        let view: Value = h.http.get(format!("{}/api/session", h.base)).send().await.unwrap().json().await.unwrap();
        assert_eq!(view["playing"], false);
        let history: Value = serde_json::from_str(&h.history().await.unwrap()).unwrap();
        let plays: HashMap<String, u64> = history["entries"].as_array().unwrap().iter()
            .map(|entry| (entry["track"]["globalId"].as_str().unwrap().to_owned(), entry["playCount"].as_u64().unwrap())).collect();
        assert_eq!(plays.get("a"), Some(&1));
        assert_eq!(plays.get("b"), Some(&1));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_queue_change_from_a_stale_revision_is_refused() {
        let h = Harness::start().await;
        let queued = json!({ "version": 1, "history": [], "current": item("a"), "upcoming": [], "tracks": [track("a")] });
        h.post("/api/session/queue", json!({ "base": 0, "queue": queued.clone() })).await;
        let response = h.http.post(format!("{}/api/session/queue", h.base)).json(&json!({ "base": 0, "queue": queued })).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(response.json::<Value>().await.unwrap()["queueRevision"], 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn session_omits_only_the_queue_the_client_already_has() {
        let h = Harness::start().await;
        let queued = json!({ "version": 1, "history": [], "current": item("a"), "upcoming": [], "tracks": [track("a")] });
        let initial = h.post("/api/session/queue", json!({ "base": 0, "queue": queued.clone() })).await;
        assert_eq!(initial["queueRevision"], 1);
        assert_eq!(initial["queue"]["current"], item("a"));

        let known: Value = h.http.get(format!("{}/api/session?queue=1", h.base)).send().await.unwrap().json().await.unwrap();
        assert!(known.get("queue").is_none());
        assert_eq!(known["queueRevision"], 1);
        let command = h.post("/api/session/command?queue=1", json!({ "action": "pause" })).await;
        assert!(command.get("queue").is_none());
        assert_eq!(command["playing"], false);

        let full: Value = h.http.get(format!("{}/api/session", h.base)).send().await.unwrap().json().await.unwrap();
        assert_eq!(full["queue"], initial["queue"], "a full recovery read always includes the queue");

        h.post("/api/session/queue", json!({ "base": 1, "queue": queued })).await;
        let stale: Value = h.http.get(format!("{}/api/session?queue=1", h.base)).send().await.unwrap().json().await.unwrap();
        assert_eq!(stale["queueRevision"], 2);
        assert_eq!(stale["queue"]["revision"], 2);

        let conflict = h.http.post(format!("{}/api/session/queue", h.base))
            .json(&json!({ "base": 1, "queue": initial["queue"] })).send().await.unwrap();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        let conflict: Value = conflict.json().await.unwrap();
        assert_eq!(conflict["session"]["queue"], stale["queue"]);
    }
}
