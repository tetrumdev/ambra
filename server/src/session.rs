//! The core: this server decides what plays, for every device that uses it.
//!
//! The server runs any number of sessions (`Sessions`), each with its own queue, transport and
//! output; apps name theirs with `?session=<id>`, or get the first, `main`. An output plays for
//! one session at a time, and so does the Spotify renderer. Plays from every session count in
//! the one listening history.
//!
//! The first session's queue is the shared `ambra.queue.v1` state (the others' are kept beside
//! it, private to the core, under `SESSION_QUEUE_PREFIX`). Only the core writes a queue: apps send the queue they want (based on the queue revision they saw), or ask for
//! next, previous and the like, and the core applies it and tells every app. The transport —
//! playing or paused, the position, the chosen output, what that output reports — lives here.
//!
//! The core plays through one output on one of the apps using this server: it tells that app
//! what to load and play (`endpoints.rs`), follows its reports, moves to the next song when
//! one ends, and counts each play in the listening history. Nothing about playback depends on
//! a controller's window being open; losing the selected audio output pauses the session.

use std::{
    sync::{Arc, Mutex as SyncMutex, OnceLock, Weak, atomic::{AtomicBool, Ordering}},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{FromRequestParts, Query, State},
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
/// The session apps get when they name none: the one every server has, which can't be removed.
pub const MAIN_SESSION: &str = "main";
const SESSIONS_FILE: &str = "sessions.v1.json";
const MAX_SESSIONS: usize = 32;
const MAX_SESSION_NAME: usize = 60;
/// A queue is saved in the shared state, so it may be as large as that allows. Axum's own
/// limit (2 MiB) refused a queue of a couple of thousand songs.
const MAX_QUEUE_BYTES: usize = 64 * 1024 * 1024;

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
    track_source: String,
    live: bool,
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
    failed_live_load: Option<Loaded>,
    queued_next: Option<Option<String>>,
    pending_play: Option<bool>,
    pending_seek: Option<f64>,
    /// The loaded song whose play has been counted, so each start counts once.
    counted: Option<(String, u64)>,
    /// Ignore reports sampled before the most recent load or transport command completed.
    report_after: Option<Instant>,
    /// The output instance and the last of its own plays, pauses and seeks the core has taken
    /// on. Sent with each transport command, so the output can tell one decided before them.
    control: Option<(Option<String>, u64)>,
    /// What the output had loaded when it went out of reach. It's kept, rather than loaded
    /// again, if the same output comes back still playing that song.
    orphaned: Option<Loaded>,
    /// A skip the output hasn't been told of: it pauses the song being left before anything
    /// else, so a slow or failing load of the next one can't leave the old one playing on.
    silence_skipped: bool,
    /// Outputs on other computers playing in step with `output`, which leads the group.
    followers: Vec<Follower>,
    /// Where the group's synced start stands, while there are followers.
    sync: SyncPhase,
    /// Counts synced starts, so each output knows which start a command belongs to.
    sync_epoch: u64,
}

/// An output playing in step with the session's own (`Transport::output`).
#[derive(Clone, Debug)]
struct Follower {
    output: Output,
    /// Where it's reached: its computer, or, when the group already plays another output there,
    /// that output's own player on it (`endpoints::output_address`). Set by `Transport::readdress`.
    address: String,
    /// What the core loaded there, as for the leading output.
    loaded: Option<Loaded>,
    queued_next: Option<Option<String>>,
    /// The synced start it was last prepared for, and the last one it was given.
    held: u64,
    started: u64,
    /// When a command to it last failed; it isn't asked again at once.
    failed_at: Option<Instant>,
}

impl Follower {
    fn new(output: Output) -> Self {
        let address = output.endpoint_id.clone();
        Self { output, address, loaded: None, queued_next: None, held: 0, started: 0, failed_at: None }
    }
}

/// How a group of outputs starts together. Every output prepares, holding its first sample,
/// and reports when it's ready; then every one is told when the group hears which position, on
/// the server's clock. That time leaves the longest resync delay any of them needs, so none
/// cuts the start of a song short to keep up with the rest.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum SyncPhase {
    /// Paused, or not yet started.
    #[default]
    Idle,
    /// Every output prepares to play from `position`, sought there or resumed (`seek`), and holds.
    Preparing { epoch: u64, position: f64, since: Instant, seek: bool },
    /// Song position `position` is heard at `at_ms`, on the clock `/api/session/clock` reads.
    /// `resync_ms` is the longest resync delay in the group, which every output waits out
    /// alike when a song in another format makes them all reopen their devices.
    Running { epoch: u64, at_ms: f64, position: f64, resync_ms: u64 },
}

/// How long the group waits for its slowest output before starting without it; that one
/// joins in step once it's ready.
const SYNC_READY_TIMEOUT: Duration = Duration::from_secs(8);
/// Time for the start to reach every output, on top of the resync delays.
const SYNC_START_MARGIN_MS: f64 = 300.0;
/// An output joining a playing group prepares from where the group will be this much later.
const SYNC_JOIN_LEAD_MS: f64 = 1500.0;
/// A follower whose command failed is asked again after this long.
const FOLLOWER_RETRY: Duration = Duration::from_secs(5);
/// A paused follower within this of the group's position resumes from its own; one further off
/// is sought, so it never waits out or drops a long stretch to line up.
const RESUME_IN_PLACE_SECONDS: f64 = 1.0;

impl Transport {
    fn synced(&self) -> bool {
        !self.followers.is_empty()
    }

    /// A new synced start: every output prepares to play from `position` and holds.
    fn begin_sync(&mut self, position: f64, seek: bool) -> u64 {
        self.sync_epoch += 1;
        self.sync = SyncPhase::Preparing { epoch: self.sync_epoch, position, since: Instant::now(), seek };
        self.sync_epoch
    }

    /// Every output, the leading one first.
    fn outputs(&self) -> Vec<Output> {
        self.output.iter().cloned().chain(self.followers.iter().map(|follower| follower.output.clone())).collect()
    }

    fn follower(&mut self, address: &str) -> Option<&mut Follower> {
        self.followers.iter_mut().find(|follower| follower.address == address)
    }

    /// Each follower's address. A computer's app plays the group's first output there itself,
    /// and each other one on a player of its own; a follower whose address changed starts afresh.
    fn readdress(&mut self) {
        let mut computers: std::collections::HashSet<String> = self.output.iter().map(|output| output.endpoint_id.clone()).collect();
        for follower in &mut self.followers {
            let address = if computers.insert(follower.output.endpoint_id.clone()) {
                follower.output.endpoint_id.clone()
            } else {
                crate::endpoints::output_address(&follower.output.endpoint_id, &follower.output.device_id)
            };
            if follower.address != address {
                follower.address = address;
                follower.loaded = None;
                follower.queued_next = None;
                follower.held = 0;
                follower.started = 0;
            }
        }
    }

    /// Where `output` is reached, while it plays in this session.
    fn address_of(&self, output: &Output) -> Option<String> {
        let same = |other: &Output| other.endpoint_id == output.endpoint_id && other.device_id == output.device_id;
        if self.output.as_ref().is_some_and(same) { return Some(output.endpoint_id.clone()); }
        self.followers.iter().find(|follower| same(&follower.output)).map(|follower| follower.address.clone())
    }
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

    /// The output's latest own change the core knows of, for that output instance.
    fn known_control(&self, instance: &Option<String>) -> u64 {
        match &self.control {
            Some((known, seq)) if known == instance => *seq,
            _ => 0,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SavedTransport {
    output: Option<Output>,
    position: f64,
    /// Outputs playing in step with `output`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    followers: Vec<Output>,
}

pub struct Core {
    state: Arc<UserState>,
    endpoints: Arc<Endpoints>,
    spotify_playback: Option<Arc<crate::soloist::Manager>>,
    transport: SyncMutex<Transport>,
    /// Bumped whenever what apps show changes; apps wait on it.
    revision: watch::Sender<u64>,
    /// Bumped with every position the output reports, for apps following the stream.
    positions: watch::Sender<u64>,
    wake: Notify,
    /// One queue change at a time, so none is lost between reading and writing it.
    queue_lock: Mutex<()>,
    /// The queue as saved and as parsed from that text. Kept while the saved text is the same,
    /// so a change by the core isn't read back and parsed again.
    queue: SyncMutex<Option<(Arc<str>, Arc<Value>)>>,
    /// The core's own latest step through the queue, for apps that have the queue before it.
    queue_patch: SyncMutex<Option<Arc<QueuePatch>>>,
    /// What `transport.v1.json` holds, so an unchanged transport isn't written again.
    saved_transport: SyncMutex<Option<Vec<u8>>>,
    /// Commands and output acknowledgements commit together: a slow load must never
    /// overwrite a pause, seek or output change that arrived while it was in flight.
    operation: Mutex<()>,
    /// Invalidates an in-flight output operation as soon as a new intent commits.
    commands: watch::Sender<u64>,
    transport_path: std::path::PathBuf,
    instance_id: String,
    id: String,
    /// Where this session's queue is kept in the shared state.
    queue_key: String,
    sessions: Weak<Sessions>,
    /// Set when the session is removed: its driver stops and its streams end.
    closed: AtomicBool,
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

/// One of this server's own URLs as just its path, without the access token. Each app writes
/// queue songs with the address it reaches the server by, and a bridged app's loopback port
/// changes with every launch. Outputs resolve `/api/` paths against their own route to the
/// server, so the path alone names the stream. Compared as whole URLs, the same song looked like
/// a different one whenever an app rewrote the queue (adding a song), and it restarted.
fn server_relative(audio: &str) -> String {
    let Some(rest) = audio.strip_prefix("http://").or_else(|| audio.strip_prefix("https://")) else {
        return audio.to_owned();
    };
    let Some(path_start) = rest.find('/') else { return audio.to_owned() };
    let (authority, path) = rest.split_at(path_start);
    let host = authority.rsplit_once(':').map_or(authority, |(host, port)| {
        if port.chars().all(|c| c.is_ascii_digit()) && !host.ends_with(':') { host } else { authority }
    });
    let host = host.trim_start_matches('[').trim_end_matches(']');
    // Only addresses an app uses for this server: an IP address, a machine name or a `.local`
    // name. A provider's own CDN URL stays whole.
    let ours = !host.is_empty() && (!host.contains('.') || host.ends_with(".local") || host.parse::<std::net::IpAddr>().is_ok());
    if !ours || !path.starts_with("/api/") {
        return audio.to_owned();
    }
    let (path, query) = path.split_once('?').map_or((path, None), |(path, query)| (path, Some(query)));
    let query = query
        .map(|query| query.split('&').filter(|pair| !pair.is_empty() && !pair.starts_with("access_token=")).collect::<Vec<_>>().join("&"))
        .filter(|query| !query.is_empty());
    query.map_or_else(|| path.to_owned(), |query| format!("{path}?{query}"))
}

/// What an output plays for `track`: its stream (a DASH song as its HLS playlist), or a file path.
fn source_of(track: &Value) -> Option<String> {
    if track["provider"] == "local" && !track["audio"].as_str().is_some_and(|audio| audio.starts_with("http") || audio.starts_with("/api/")) {
        return track["providerTrackId"].as_str().map(str::to_owned);
    }
    let audio = server_relative(track["audio"].as_str()?);
    let audio = audio.as_str();
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

fn array_len(value: &Value) -> usize {
    value.as_array().map_or(0, Vec::len)
}

/// How the core itself moves through the queue.
#[derive(Clone, Copy, PartialEq)]
enum QueueStep {
    /// On to the next song; nothing happens when there is none.
    Advance,
    /// On to the next song, or the end of the queue after the last one.
    AdvanceOrFinish,
    /// Back to the song played before.
    Rewind,
}

/// One step through the queue, as what it did to revision `base`. Moving on a song changes
/// three entries of a queue that can hold thousands of songs; an app that has `base` applies
/// this instead of being sent the whole queue again.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueuePatch {
    base: u64,
    revision: u64,
    /// Entries removed from the start and the end of the history, then those added at its end.
    history_drop_front: usize,
    history_drop_back: usize,
    history_push: Vec<Value>,
    current: Value,
    /// Entries removed from the start of what's upcoming, then those put in front of it.
    upcoming_drop_front: usize,
    upcoming_unshift: Vec<Value>,
}

fn empty_queue() -> Value {
    json!({ "version": 1, "history": [], "current": null, "upcoming": [], "tracks": [] })
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

impl Core {
    fn open(id: &str, sessions: &Arc<Sessions>) -> Shared {
        let state = sessions.state.clone();
        let main = id == MAIN_SESSION;
        let transport_path = state.directory().join(if main { TRANSPORT_FILE.to_owned() } else { format!("transport.{id}.v1.json") });
        let saved: SavedTransport = std::fs::read(&transport_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        // Followers play in step with an output; with none saved, neither are they.
        let followers = if saved.output.is_some() { saved.followers.into_iter().map(Follower::new).collect() } else { Vec::new() };
        let mut transport = Transport { output: saved.output, position: saved.position, followers, ..Transport::default() };
        transport.readdress();
        let core = Arc::new(Self {
            state,
            endpoints: sessions.endpoints.clone(),
            spotify_playback: sessions.spotify_playback.clone(),
            transport: SyncMutex::new(transport),
            revision: watch::channel(1).0,
            positions: watch::channel(0).0,
            wake: Notify::new(),
            queue_lock: Mutex::new(()),
            queue: SyncMutex::new(None),
            queue_patch: SyncMutex::new(None),
            saved_transport: SyncMutex::new(None),
            operation: Mutex::new(()),
            commands: watch::channel(0).0,
            transport_path,
            instance_id: crate::server_config::random_hex(16),
            id: id.to_owned(),
            queue_key: if main { QUEUE_KEY.to_owned() } else { format!("{}{id}", crate::user_state::SESSION_QUEUE_PREFIX) },
            sessions: Arc::downgrade(sessions),
            closed: AtomicBool::new(false),
        });
        tokio::spawn(drive(core.clone()));
        core
    }

    /// The Spotify renderer, while this session may use it. It renders one stream at a time:
    /// `claim` takes it for a session about to play Spotify, pausing the session that had it.
    /// Unclaimed, any session may use it; claimed by another, none but that one.
    fn soloist(&self, claim: bool) -> Option<Arc<crate::soloist::Manager>> {
        let manager = self.spotify_playback.clone()?;
        let sessions = self.sessions.upgrade()?;
        let previous = {
            let mut owner = sessions.soloist_owner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match owner.as_deref() {
                Some(id) if id == self.id => return Some(manager),
                Some(_) if !claim => return None,
                None if !claim => return Some(manager),
                _ => owner.replace(self.id.clone()),
            }
        };
        if let Some(previous) = previous.and_then(|id| sessions.core(&id)) { previous.yield_soloist(); }
        Some(manager)
    }

    /// Lets another session take the Spotify renderer without pausing this one.
    fn release_soloist(&self) {
        let Some(sessions) = self.sessions.upgrade() else { return };
        let mut owner = sessions.soloist_owner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if owner.as_deref() == Some(self.id.as_str()) { *owner = None; }
    }

    /// Whether another session holds the Spotify renderer.
    fn soloist_elsewhere(&self) -> bool {
        self.spotify_playback.is_some() && self.sessions.upgrade().is_some_and(|sessions| {
            sessions.soloist_owner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_deref().is_some_and(|id| id != self.id)
        })
    }

    /// Another session started Spotify, which plays one stream at a time: this one pauses.
    fn yield_soloist(&self) {
        let mut transport = self.transport();
        if transport.playing {
            transport.position = transport.position_now();
            transport.position_at = Some(Instant::now());
            transport.playing = false;
            transport.pending_play = Some(false);
        }
        transport.error = Some("Spotify started playing in another session".into());
        drop(transport);
        self.commands.send_modify(|revision| *revision += 1);
        self.changed();
    }

    /// Another session took this session's output; this one keeps its song and position. The
    /// outputs that played in step with it stop too.
    fn drop_output(&self) {
        let mut transport = self.transport();
        transport.position = transport.position_now();
        transport.position_at = Some(Instant::now());
        transport.output = None;
        transport.playing = false;
        transport.buffering = false;
        transport.loaded = None;
        transport.orphaned = None;
        transport.queued_next = None;
        transport.pending_play = None;
        transport.pending_seek = None;
        transport.sync = SyncPhase::Idle;
        let followers: Vec<String> = transport.followers.drain(..)
            .filter(|follower| follower.loaded.is_some())
            .map(|follower| follower.address)
            .collect();
        drop(transport);
        self.commands.send_modify(|revision| *revision += 1);
        self.save_transport();
        self.changed();
        let endpoints = self.endpoints.clone();
        tokio::spawn(async move {
            for endpoint in followers {
                let _ = endpoints.call(&endpoint, "pause_native_audio", json!({})).await;
            }
        });
    }

    /// Another session took one of the outputs playing in step with this session's own.
    fn drop_follower(&self, endpoint: &str) {
        let mut transport = self.transport();
        let before = transport.followers.len();
        transport.followers.retain(|follower| follower.output.endpoint_id != endpoint);
        if transport.followers.len() == before { return; }
        if transport.followers.is_empty() { transport.sync = SyncPhase::Idle; }
        transport.readdress();
        drop(transport);
        self.save_transport();
        self.changed();
    }

    fn closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// Takes on a play, pause or seek made on the output itself. The listener in front of it
    /// decides; it happened after anything the core asked of that output before hearing of it,
    /// so it replaces the core's own pending play, pause or seek.
    fn adopt_control(&self, endpoint: &str, status: &Value, instance: &Option<String>, sampled_at: Instant) {
        let Some(seq) = status["control"]["seq"].as_u64() else { return };
        let mut transport = self.transport();
        if transport.output.as_ref().is_none_or(|output| output.endpoint_id != endpoint) { return; }
        if seq <= transport.known_control(instance) { return; }
        transport.control = Some((instance.clone(), seq));
        // Only the core's own song on that engine; anything else is settled by the driver.
        let playing_ours = transport.loaded.as_ref().is_some_and(|loaded| loaded.endpoint_id == endpoint
            && &loaded.endpoint_instance == instance && status["currentSource"].as_str() == Some(loaded.source.as_str()));
        if !playing_ours { return; }
        let playing = status["control"]["playing"].as_bool().unwrap_or(transport.playing);
        let engine_playing = status["isPlaying"].as_bool().unwrap_or(false);
        transport.playing = playing;
        // In a synced group the rest follow: a pause pauses them, and anything else starts the
        // group again together from where this output is.
        transport.pending_play = transport.synced().then_some(playing);
        transport.pending_seek = None;
        transport.buffering = playing && (status["buffering"] == true || !engine_playing);
        if let Some(position) = status["currentTime"].as_f64() {
            transport.position = position.max(0.0);
            transport.position_at = Some(sampled_at);
        }
        drop(transport);
        self.changed();
    }

    fn transport(&self) -> std::sync::MutexGuard<'_, Transport> {
        self.transport.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Something apps show changed; the driver also looks again at once.
    fn changed(&self) {
        self.revision.send_modify(|revision| *revision += 1);
        self.wake.notify_one();
    }

    fn pause_disconnected_output(&self) {
        let mut transport = self.transport();
        let changed = transport.playing || transport.buffering || transport.loaded.is_some()
            || transport.pending_play.is_some() || transport.pending_seek.is_some();
        // Hold the last confirmed (or explicitly sought) position, without counting
        // the time since the vanished output's last report as audible playback.
        transport.position_at = Some(Instant::now());
        transport.playing = false;
        transport.buffering = false;
        if let Some(loaded) = transport.loaded.take() { transport.orphaned = Some(loaded); }
        transport.queued_next = None;
        transport.pending_play = None;
        transport.pending_seek = None;
        transport.report_after = None;
        transport.sync = SyncPhase::Idle;
        drop(transport);
        if changed {
            self.save_transport();
            self.changed();
        }
    }

    /// Takes back the load an output had when it went out of reach, if it came back still
    /// playing that song (or the queued one after it), so it isn't stopped and started again.
    fn restore_orphaned(&self, endpoint: &str, device: &str, instance: &Option<String>, track_source: &str, next: Option<&str>, status: &Value) {
        let mut transport = self.transport();
        if transport.loaded.is_some() { return; }
        let Some(orphaned) = transport.orphaned.take() else { return };
        let source = status["currentSource"].as_str();
        let same = instance.is_some() && !orphaned.live && orphaned.endpoint_id == endpoint && &orphaned.endpoint_instance == instance
            && orphaned.device_id == device && orphaned.generation == transport.generation && orphaned.track_source == track_source
            && status["error"].is_null() && status["ended"] != true
            && (source == Some(orphaned.source.as_str()) || source.is_some() && source == next);
        if !same { return; }
        if transport.pending_play.is_none() {
            transport.playing = status["isPlaying"] == true || status["buffering"] == true;
        }
        if transport.pending_seek.is_none() && source == Some(orphaned.source.as_str()) && let Some(position) = status["currentTime"].as_f64() {
            transport.set_position(position);
        }
        transport.buffering = transport.playing && status["isPlaying"] != true;
        transport.loaded = Some(orphaned);
        transport.queued_next = None;
        transport.report_after = None;
        transport.error = None;
        drop(transport);
        self.changed();
    }

    pub(crate) fn save_transport(&self) {
        let saved = {
            let transport = self.transport();
            SavedTransport {
                output: transport.output.clone(),
                position: transport.position_now(),
                followers: transport.followers.iter().map(|follower| follower.output.clone()).collect(),
            }
        };
        let Ok(bytes) = serde_json::to_vec(&saved) else { return };
        // Asked for every few seconds: a paused or idle session has nothing new to write.
        let mut written = self.saved_transport.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if written.as_deref() == Some(bytes.as_slice()) { return; }
        if crate::server_config::write_private(&self.transport_path, &bytes).is_ok() {
            *written = Some(bytes);
        }
    }

    fn cached_queue(&self) -> Option<Arc<Value>> {
        self.queue.lock().ok().and_then(|queue| queue.as_ref().map(|(_, parsed)| parsed.clone()))
    }

    fn parse_queue(saved: Option<&str>) -> Value {
        saved
            .and_then(|saved| serde_json::from_str::<Value>(saved).ok())
            .filter(|queue| queue["version"] == 1)
            .unwrap_or_else(empty_queue)
    }

    /// The queue as last read; read again when the shared state holds a different one.
    async fn queue(&self) -> Arc<Value> {
        if let Some(queue) = self.cached_queue() {
            return queue;
        }
        let _guard = self.queue_lock.lock().await;
        if let Some(queue) = self.cached_queue() { return queue; }
        let saved = self.state.value(&self.queue_key).await.ok().flatten();
        let queue = Arc::new(Self::parse_queue(saved.as_deref()));
        if let Ok(mut cached) = self.queue.lock() {
            *cached = Some((saved.unwrap_or_default().into(), queue.clone()));
        }
        queue
    }

    /// The shared state changed: the queue is read again only if it isn't the one kept here.
    /// Nearly every change is another key's, or the core's own queue change, already kept.
    async fn refresh_queue(&self) {
        let _guard = self.queue_lock.lock().await;
        let saved = self.state.value(&self.queue_key).await.ok().flatten().unwrap_or_default();
        if let Ok(mut cached) = self.queue.lock()
            && cached.as_ref().is_some_and(|(text, _)| **text != *saved)
        {
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
            .update(&self.queue_key, move |saved| {
                let mut queue = Self::parse_queue(saved);
                let (changed, result) = change(&mut queue)?;
                if !changed {
                    return Ok((saved.map(str::to_owned), (None, result)));
                }
                queue["revision"] = json!(queue_revision(&queue) + 1);
                let text = queue.to_string();
                Ok((Some(text.clone()), (Some((Arc::<str>::from(text), Arc::new(queue))), result)))
            })
            .await;
        let result = match result {
            Ok((changed, result)) => {
                // Kept as written, rather than read back and parsed again for the next look.
                if let (Some(changed), Ok(mut cached)) = (changed, self.queue.lock()) {
                    *cached = Some(changed);
                }
                Ok(result)
            }
            Err(message) => Err(message),
        };
        self.changed();
        result
    }

    /// Moves through the queue as the core itself does, and remembers the move as a patch.
    /// `None` if the queue had nowhere to go.
    async fn step_queue(&self, step: QueueStep) -> Result<Option<Arc<QueuePatch>>, String> {
        let patch = self.change_queue(move |queue| {
            let base = queue_revision(queue);
            let (history_before, upcoming_before) = (array_len(&queue["history"]), array_len(&queue["upcoming"]));
            let leaving = queue["current"].clone();
            let moved = match step {
                QueueStep::Advance => advance(queue),
                QueueStep::AdvanceOrFinish => { if !advance(queue) { finish(queue); } true }
                QueueStep::Rewind => rewind(queue),
            };
            if !moved { return Ok((false, None)); }
            let history_after = array_len(&queue["history"]);
            let patch = if step == QueueStep::Rewind {
                QueuePatch {
                    base, revision: base + 1,
                    history_drop_front: 0, history_drop_back: 1, history_push: Vec::new(),
                    current: queue["current"].clone(),
                    upcoming_drop_front: 0,
                    upcoming_unshift: if leaving.is_null() { Vec::new() } else { vec![leaving] },
                }
            } else {
                // The song left joins the history, which keeps only its most recent entries.
                let pushed = usize::from(!leaving.is_null());
                let history_push = queue["history"].as_array().map_or_else(Vec::new, |history| history[history.len() - pushed.min(history.len())..].to_vec());
                QueuePatch {
                    base, revision: base + 1,
                    history_drop_front: (history_before + pushed).saturating_sub(history_after), history_drop_back: 0, history_push,
                    current: queue["current"].clone(),
                    upcoming_drop_front: upcoming_before - array_len(&queue["upcoming"]),
                    upcoming_unshift: Vec::new(),
                }
            };
            Ok((true, Some(patch)))
        }).await?;
        let patch = patch.map(Arc::new);
        if let (Some(patch), Ok(mut latest)) = (&patch, self.queue_patch.lock()) {
            *latest = Some(patch.clone());
        }
        Ok(patch)
    }

    async fn record_play(&self, track: Value) {
        let recorded = self
            .state
            .update_patched(HISTORY_KEY, move |saved| {
                let mut history = saved
                    .and_then(|saved| serde_json::from_str::<Value>(saved).ok())
                    .filter(|history| history["version"] == 1 && history["entries"].is_array())
                    .unwrap_or_else(|| json!({ "version": 1, "entries": [] }));
                let entries = history["entries"].as_array_mut().expect("checked above");
                let id = track["globalId"].clone();
                let previous = entries.iter().position(|entry| entry["track"]["globalId"] == id).map(|index| entries.remove(index));
                // Entries from before play counts were kept count as one play.
                let plays = previous.map_or(0, |entry| entry["playCount"].as_u64().unwrap_or(1)) + 1;
                let entry = json!({ "track": track, "lastPlayedAt": now_ms(), "playCount": plays });
                entries.insert(0, entry.clone());
                // Apps holding the history are sent this one entry, not every song ever played:
                // it goes first, in place of any entry for the same song.
                Ok((Some(history.to_string()), Some(json!({ "play": entry })), ()))
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
    /// What the output was told to play, as the core sent it. The output's own app compares
    /// it with its engine, and while they match follows the engine's position directly.
    #[serde(skip_serializing_if = "Option::is_none")]
    loaded_source: Option<String>,
    duration: f64,
    buffering: bool,
    error: Option<String>,
    audio_quality: Value,
    output: Option<Output>,
    output_online: bool,
    /// Every output playing, in step: `output` first, then those following it.
    outputs: Vec<Output>,
    /// The queue revision this view goes with.
    queue_revision: u64,
    /// Left out when the app already has this revision: a long queue is large, and play,
    /// pause and buffering change the view far more often than the queue changes.
    #[serde(skip_serializing_if = "Option::is_none")]
    queue: Option<Kept<Value>>,
    /// In place of `queue`, for an app that has the revision before this one and asked for
    /// patches: what the core's step through the queue changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    queue_patch: Option<Kept<QueuePatch>>,
}

/// The queue (or its patch) as it is kept, written out without copying it first.
struct Kept<T>(Arc<T>);
impl<T: Serialize> Serialize for Kept<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

/// How an app that doesn't have the current queue is told of it.
#[derive(Clone, Copy, PartialEq)]
enum QueueDetail {
    /// The whole queue.
    Whole,
    /// A patch from the revision the app has, when the core's latest step is that; else the whole queue.
    Patched,
    /// A patch or nothing: the app asks for a queue it can't patch (`/api/session`, compressed),
    /// so the stream never carries one. An app that changed the queue itself already has it
    /// from the answer to that change.
    PatchedOrLeftOut,
}

impl QueueDetail {
    fn of(patches: Option<u8>) -> Self {
        if patches.is_some_and(|patches| patches > 0) { Self::Patched } else { Self::Whole }
    }
}

/// `known_queue`: the queue revision the app already has, if any.
async fn view(core: &Core, known_queue: Option<u64>, detail: QueueDetail) -> SessionView {
    let queue = core.queue().await;
    let queue_revision = queue_revision(&queue);
    let queue_patch = (detail != QueueDetail::Whole && known_queue != Some(queue_revision))
        .then(|| core.queue_patch.lock().ok().and_then(|patch| patch.clone()))
        .flatten()
        .filter(|patch| Some(patch.base) == known_queue && patch.revision == queue_revision);
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
        loaded_source: transport.loaded.as_ref().map(|loaded| loaded.source.clone()),
        duration: transport.duration,
        buffering: transport.buffering,
        error: transport.error.clone(),
        audio_quality: transport.audio_quality.clone(),
        output: transport.output.clone(),
        output_online,
        outputs: transport.outputs(),
        queue: (known_queue != Some(queue_revision) && queue_patch.is_none() && detail != QueueDetail::PatchedOrLeftOut).then(|| Kept(queue.clone())),
        queue_patch: queue_patch.map(Kept),
        queue_revision,
    }
}

/// Where `server_time_ms` counts from.
fn server_clock_start() -> Instant {
    static START: OnceLock<Instant> = OnceLock::new();
    *START.get_or_init(Instant::now)
}

/// Milliseconds on a clock that only moves forward, from an arbitrary start in this process.
fn server_time_ms() -> f64 {
    server_clock_start().elapsed().as_secs_f64() * 1000.0
}

/// When `ms`, on `server_time_ms`'s clock, comes (or came).
fn server_instant(ms: f64) -> Instant {
    server_clock_start() + Duration::from_secs_f64(ms.max(0.0) / 1000.0)
}

/// Answered at once, so an app can time the round trip and line its clock up with this one.
async fn clock() -> Json<Value> {
    Json(json!({ "serverTimeMs": server_time_ms() }))
}

pub fn router<S: Clone + Send + Sync + 'static>(sessions: Arc<Sessions>) -> Router<S> {
    Router::new()
        .route("/api/session", get(read))
        .route("/api/session/stream", get(stream))
        .route("/api/session/clock", get(clock))
        .route("/api/session/queue", post(set_queue).layer(axum::extract::DefaultBodyLimit::max(MAX_QUEUE_BYTES)))
        .route("/api/session/command", post(command))
        .route("/api/sessions", get(list_sessions).post(create_session))
        .route("/api/sessions/{id}/rename", post(rename_session))
        .route("/api/sessions/{id}/delete", post(delete_session))
        .with_state(sessions)
}

#[derive(Deserialize)]
struct SessionQuery {
    session: Option<String>,
}

/// The session a request is for: `?session=<id>`, or the first one when it names none.
struct InSession(Shared);

impl FromRequestParts<Arc<Sessions>> for InSession {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut axum::http::request::Parts, sessions: &Arc<Sessions>) -> Result<Self, Response> {
        let id = Query::<SessionQuery>::try_from_uri(&parts.uri).ok().and_then(|Query(query)| query.session);
        sessions.core(id.as_deref().unwrap_or(MAIN_SESSION)).map(InSession)
            .ok_or_else(|| error(StatusCode::NOT_FOUND, "That session no longer exists"))
    }
}

#[derive(Deserialize)]
struct ReadQuery {
    since: Option<u64>,
    wait: Option<u64>,
    /// The queue revision the app has; the queue is sent only when it's different.
    queue: Option<u64>,
    /// Set by apps that take a `queuePatch` in place of the queue.
    patches: Option<u8>,
}

async fn read(InSession(core): InSession, Query(query): Query<ReadQuery>) -> Json<SessionView> {
    if let (Some(since), Some(wait)) = (query.since, query.wait.filter(|wait| *wait > 0)) {
        let mut revision = core.revision.subscribe();
        let _ = tokio::time::timeout(Duration::from_secs(wait.min(MAX_WAIT_SECONDS)), revision.wait_for(|current| *current != since)).await;
    }
    Json(view(&core, query.queue, QueueDetail::of(query.patches)).await)
}

#[derive(Deserialize)]
struct StreamQuery {
    /// The queue revision the app has; the queue is sent only when it's different.
    queue: Option<u64>,
    /// Set by apps that take a `queuePatch` and ask for any queue they can't patch.
    patches: Option<u8>,
}

/// Positions are sent at most this often; anything else that changes is sent at once.
const STREAM_POSITION_EVERY: Duration = Duration::from_millis(250);
/// Sent anyway after this long, so a quiet stream still shows it's alive.
const STREAM_HEARTBEAT: Duration = Duration::from_secs(10);

/// The session as it changes, one view per line: at once for anything an app shows, and with
/// each position the output reports. Apps following it don't wait on a poll to see either.
async fn stream(InSession(core): InSession, Query(query): Query<StreamQuery>) -> Response {
    struct Follow { core: Shared, revision: watch::Receiver<u64>, positions: watch::Receiver<u64>, queue: Option<u64>, detail: QueueDetail, sent: Option<Instant> }
    let detail = if QueueDetail::of(query.patches) == QueueDetail::Patched { QueueDetail::PatchedOrLeftOut } else { QueueDetail::Whole };
    let follow = Follow { revision: core.revision.subscribe(), positions: core.positions.subscribe(), core, queue: query.queue, detail, sent: None };
    let lines = futures_util::stream::unfold(follow, |mut follow| async move {
        if follow.core.closed() { return None; }
        if let Some(sent) = follow.sent {
            tokio::select! {
                changed = follow.revision.changed() => { if changed.is_err() { return None; } }
                changed = follow.positions.changed() => {
                    if changed.is_err() { return None; }
                    // Only the position moved: wait out the interval, unless something else changes.
                    tokio::select! {
                        _ = follow.revision.changed() => {}
                        () = tokio::time::sleep_until((sent + STREAM_POSITION_EVERY).into()) => {}
                    }
                }
                () = tokio::time::sleep(STREAM_HEARTBEAT) => {}
            }
        }
        if follow.core.closed() { return None; }
        follow.revision.mark_unchanged();
        follow.positions.mark_unchanged();
        let view = view(&follow.core, follow.queue, follow.detail).await;
        follow.queue = Some(view.queue_revision);
        follow.sent = Some(Instant::now());
        let mut line = serde_json::to_vec(&view).unwrap_or_default();
        line.push(b'\n');
        Some((Ok::<_, std::convert::Infallible>(line), follow))
    });
    Response::builder()
        .header("content-type", "application/x-ndjson")
        .header("cache-control", "no-store")
        .body(axum::body::Body::from_stream(lines))
        .map_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response(), IntoResponse::into_response)
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

async fn set_queue(InSession(core): InSession, Json(change): Json<QueueChange>) -> Response {
    let _operation = core.operation.lock().await;
    if change.queue["version"] != 1 {
        return error(StatusCode::BAD_REQUEST, "Unsupported queue");
    }
    let base = change.base;
    let replay = change.play_track_id.is_some();
    let mut queue = change.queue;
    let applied = core
        .change_queue(move |saved| {
            let current = queue_revision(saved);
            if current != base {
                return Ok((false, Err(current)));
            }
            queue["revision"] = json!(current);
            // Another song made current (a shuffle, a new list) starts like a skip.
            let moved = saved["current"]["globalTrackId"] != queue["current"]["globalTrackId"];
            // Editing upcoming songs must not replace the stream already playing with
            // refreshed metadata (a download, new quality or a renewed stream URL).
            if !moved && !replay {
                if let Some(active) = track_of(saved, &saved["current"]) {
                    if let Some(tracks) = queue["tracks"].as_array_mut() {
                        tracks.retain(|track| track["globalId"] != active["globalId"]);
                        tracks.push(active.clone());
                    }
                }
            }
            *saved = queue;
            Ok((true, Ok(moved)))
        })
        .await;
    match applied {
        Ok(Ok(moved)) => {
            // A queue-only edit must not cancel and resend an in-flight audio load.
            if moved || replay { core.commands.send_modify(|revision| *revision += 1); }
            if moved { core.transport().silence_skipped = true; }
        }
        Ok(Err(current)) => {
            return (StatusCode::CONFLICT, Json(json!({ "error": "The queue changed meanwhile", "queueRevision": current, "session": view(&core, None, QueueDetail::Whole).await }))).into_response();
        }
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    }
    if let Some(track_id) = change.play_track_id {
        play_track(&core, &track_id).await;
    }
    Json(view(&core, None, QueueDetail::Whole).await).into_response()
}

async fn play_track(core: &Core, track_id: &str) {
    let queue = core.queue().await;
    let is_current = queue["current"]["globalTrackId"].as_str() == Some(track_id);
    let mut transport = core.transport();
    if is_current {
        transport.generation += 1;
        transport.pending_seek = None;
        transport.set_position(0.0);
        transport.playing = true;
        transport.buffering = true;
        transport.error = None;
        transport.silence_skipped = true;
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
    /// Plays on all of these in step, the first leading; at most one output per computer.
    Outputs { outputs: Vec<Output> },
    /// Sets `output`'s volume, or the leading output's when none is named.
    Volume { volume: f64, #[serde(default)] output: Option<Output> },
}

async fn command(InSession(core): InSession, Query(query): Query<ReadQuery>, Json(command): Json<Command>) -> Response {
    let retry_live = matches!(&command, Command::Play | Command::Toggle | Command::Seek { .. }) && core.transport().error.is_some();
    let interrupts_live = retry_live || matches!(&command, Command::Pause | Command::Stop | Command::Seek { .. } | Command::Next | Command::Previous | Command::PlayTrack { .. } | Command::Output { .. } | Command::Outputs { .. })
        || matches!(&command, Command::Toggle) && core.transport().playing;
    if interrupts_live && let Some(manager) = core.soloist(false) { manager.interrupt(); }
    let guard = core.operation.lock().await;
    if !matches!(&command, Command::Volume { .. }) {
        core.commands.send_modify(|revision| *revision += 1);
    }
    let mut operation = OutputOperation { core: &core, operation: Some(guard), commands: core.commands.subscribe() };
    core.transport().failed_live_load = None;
    if retry_live && let Some(manager) = core.soloist(false) {
        if operation.wait(manager.retry_playback()).await.is_err() {
            return Json(view(&core, query.queue, QueueDetail::of(query.patches)).await).into_response();
        }
    }
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
            transport.buffering = playing;
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
            transport.buffering = transport.playing;
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
            let rewound = !restart && core.step_queue(QueueStep::Rewind).await.is_ok_and(|patch| patch.is_some());
            let mut transport = core.transport();
            transport.set_position(0.0);
            transport.buffering = transport.playing;
            if !rewound {
                transport.pending_seek = Some(0.0);
            } else {
                transport.generation += 1;
            }
            transport.silence_skipped = true;
            drop(transport);
            core.changed();
            Ok(())
        }
        Command::Stop => {
            let mut transport = core.transport();
            transport.playing = false;
            transport.buffering = false;
            transport.pending_play = Some(false);
            transport.set_position(0.0);
            drop(transport);
            core.changed();
            Ok(())
        }
        Command::Output { output } => {
            drop(operation.operation.take());
            set_outputs(&core, output.into_iter().collect()).await;
            Ok(())
        }
        Command::Outputs { outputs } => {
            drop(operation.operation.take());
            // Only apps that keep time with the others join a group (`syncV1` in their reports).
            // Only apps with players to spare play several of their computer's outputs (`satellitesV1`).
            let mut unable = None;
            if outputs.len() > 1 {
                for (index, output) in outputs.iter().enumerate() {
                    let shares = outputs[..index].iter().any(|other| other.endpoint_id == output.endpoint_id && other.device_id != output.device_id);
                    if let Some((status, ..)) = core.endpoints.status(&output.endpoint_id).await
                        && (status["syncV1"] != true || shares && status["satellitesV1"] != true)
                    {
                        unable = Some((output.endpoint_name.clone(), shares));
                        break;
                    }
                }
            }
            match unable {
                Some((name, true)) => Err(format!("{name} can't play several of its outputs at once. Update Ambra there first.")),
                Some((name, false)) => Err(format!("{name} can't play in step with other outputs. Update Ambra there first.")),
                None => {
                    set_outputs(&core, outputs).await;
                    Ok(())
                }
            }
        }
        Command::Volume { volume, output: named } => {
            // Each output in a group keeps its own volume; only one that's playing can be set.
            let address = {
                let transport = core.transport();
                match named {
                    Some(named) => transport.address_of(&named).ok_or("That output isn't playing"),
                    None => transport.output.as_ref().map(|output| output.endpoint_id.clone()).ok_or("Choose an output first"),
                }
            };
            drop(operation.operation.take());
            match address {
                _ if !volume.is_finite() || !(0.0..=100.0).contains(&volume) => Err("Volume is 0 to 100".into()),
                Ok(address) => core.endpoints.call(&address, "set_native_audio_volume", json!({ "volume": volume })).await.map(|_| ()),
                Err(message) => Err(message.into()),
            }
        }
    };
    match result {
        Ok(()) => Json(view(&core, query.queue, QueueDetail::of(query.patches)).await).into_response(),
        Err(message) => error(StatusCode::BAD_REQUEST, message),
    }
}

/// Plays on `outputs` from now on, in step, the first leading the rest. Several may be on one
/// computer; an output named twice counts once.
async fn set_outputs(core: &Core, outputs: Vec<Output>) {
    let mut named = std::collections::HashSet::new();
    let mut outputs: Vec<Output> = outputs.into_iter().filter(|output| named.insert((output.endpoint_id.clone(), output.device_id.clone()))).collect();
    let leader = (!outputs.is_empty()).then(|| outputs.remove(0));
    let stopped = {
        let mut transport = core.transport();
        let previous = transport.output.clone();
        let mut stopped = Vec::new();
        if previous != leader {
            transport.position = transport.position_now();
            transport.position_at = Some(Instant::now());
            transport.output = leader.clone();
            transport.loaded = None;
            transport.orphaned = None;
            transport.queued_next = None;
            transport.error = None;
            // The song moves: the old output stops, and the driver loads it on the new one.
            if let Some(previous) = previous { stopped.push(previous.endpoint_id); }
        }
        let was_synced = transport.synced();
        let mut kept = std::mem::take(&mut transport.followers);
        transport.followers = outputs.into_iter().map(|output| match kept.iter().position(|follower| follower.output == output) {
            Some(index) => kept.remove(index),
            None => Follower::new(output),
        }).collect();
        // A follower whose player now leads, or plays another follower, isn't stopped.
        let before: Vec<String> = transport.followers.iter().filter(|follower| follower.loaded.is_some()).map(|follower| follower.address.clone()).collect();
        transport.readdress();
        stopped.extend(kept.into_iter().filter(|follower| follower.loaded.is_some()).map(|follower| follower.address));
        stopped.extend(before);
        let playing: Vec<String> = transport.output.iter().map(|output| output.endpoint_id.clone())
            .chain(transport.followers.iter().map(|follower| follower.address.clone())).collect();
        stopped.retain(|address| !playing.contains(address));
        if !transport.synced() {
            transport.sync = SyncPhase::Idle;
        } else if !was_synced && transport.playing && transport.loaded.is_some() && transport.sync == SyncPhase::Idle {
            // A song playing on one output starts again on the whole group, together.
            transport.pending_play = Some(true);
        }
        stopped
    };
    // An output plays for one session: any other session using it lets it go.
    let ours = core.transport().outputs();
    if let Some(sessions) = core.sessions.upgrade() {
        for other in sessions.cores() {
            if other.id == core.id { continue; }
            for output in &ours {
                if other.transport().output.as_ref().is_some_and(|theirs| theirs.endpoint_id == output.endpoint_id) {
                    other.drop_output();
                } else {
                    other.drop_follower(&output.endpoint_id);
                }
            }
        }
    }
    for endpoint in stopped {
        let _ = core.endpoints.call(&endpoint, "pause_native_audio", json!({})).await;
    }
    core.save_transport();
    core.changed();
}

/// Next: the queue moves on and the new song plays from its start.
async fn skip(core: &Core, forward: bool) -> Result<(), String> {
    let advanced = core.step_queue(if forward { QueueStep::Advance } else { QueueStep::Rewind }).await?.is_some();
    if advanced {
        let mut transport = core.transport();
        transport.generation += 1;
        transport.pending_seek = None;
        transport.set_position(0.0);
        transport.buffering = transport.playing;
        transport.silence_skipped = true;
        drop(transport);
        core.changed();
    }
    Ok(())
}

// ---------- Playing on the chosen output ----------

async fn drive(core: Shared) {
    let mut state_changes = core.state.subscribe();
    let mut saved_at = Instant::now();
    let mut position_reported_at = Instant::now();
    loop {
        // Without an output there is nothing to keep in time: choosing one, a queue change or
        // a command wakes the driver. Idle sessions (every one but the playing one) then cost
        // no wakeups, rather than four a second each.
        let idle = core.transport().output.is_none();
        tokio::select! {
            _ = core.wake.notified() => {}
            _ = core.endpoints.reported() => {}
            changed = state_changes.changed() => {
                if changed.is_err() { return; }
                core.refresh_queue().await;
            }
            _ = tokio::time::sleep(TICK), if !idle => {}
        }
        if core.closed() { return; }
        if let Err(message) = step(&core).await {
            if message == SUPERSEDED { continue; }
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
        if position_reported_at.elapsed() >= Duration::from_secs(1) {
            let running = { let transport = core.transport(); transport.playing && !transport.buffering };
            if running { core.changed(); }
            position_reported_at = Instant::now();
        }
    }
}

/// Private control flow: a cancelled output operation is not a playback failure.
const SUPERSEDED: &str = "Session output operation superseded";

/// State transitions remain serialized, but endpoint/provider I/O never owns the
/// session operation lock. New commands cancel the wait before any stale commit.
struct OutputOperation<'a> {
    core: &'a Core,
    operation: Option<tokio::sync::MutexGuard<'a, ()>>,
    commands: watch::Receiver<u64>,
}

impl OutputOperation<'_> {
    async fn wait<T>(&mut self, future: impl std::future::Future<Output = T>) -> Result<T, String> {
        drop(self.operation.take());
        // Provider shutdown owns child processes and must finish joining them.
        let result = future.await;
        self.operation = Some(self.core.operation.lock().await);
        if self.commands.has_changed().unwrap_or(true) { return Err(SUPERSEDED.into()); }
        Ok(result)
    }

    async fn interruptible<T>(&mut self, future: impl std::future::Future<Output = T>) -> Result<T, String> {
        drop(self.operation.take());
        let result = tokio::select! {
            biased;
            _ = self.commands.changed() => None,
            result = future => Some(result),
        };
        self.operation = Some(self.core.operation.lock().await);
        if self.commands.has_changed().unwrap_or(true) || result.is_none() {
            return Err(SUPERSEDED.into());
        }
        Ok(result.expect("checked output result"))
    }
}

/// One look at the session and the output: loads, play, pause, seeks, and moving on.
async fn step(core: &Core) -> Result<(), String> {
    let operation = core.operation.lock().await;
    let mut io = OutputOperation { core, operation: Some(operation), commands: core.commands.subscribe() };
    macro_rules! remote {
        ($future:expr) => { io.interruptible($future).await? };
    }
    macro_rules! provider {
        ($future:expr) => { io.wait($future).await? };
    }
    macro_rules! stop_soloist {
        () => {
            if let Some(manager) = core.soloist(false) { provider!(manager.stop_playback()); manager.clear_effective_renderer(); }
            core.release_soloist();
        };
    }
    let queue = core.queue().await;
    let (current, mut next) = current_and_next(&queue);
    let Some(output) = core.transport().output.clone() else {
        stop_soloist!();
        return Ok(());
    };
    let endpoint = output.endpoint_id.clone();
    // Outputs following this one play in step with it, each starting with the others.
    let synced = core.transport().synced();

    let Some((track, canonical_source)) = current else {
        stop_soloist!();
        pause_followers(core, &mut io, true).await?;
        // Nothing to play: the output stops if it was playing something.
        let was_loaded = core.transport().loaded.take().is_some();
        if was_loaded {
            let _ = remote!(core.endpoints.call(&endpoint, "pause_native_audio", json!({})));
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
        stop_soloist!();
        let was_loaded = {
            let mut transport = core.transport();
            let loaded = transport.loaded.take().is_some();
            transport.playing = false;
            transport.buffering = false;
            transport.queued_next = None;
            loaded
        };
        if was_loaded {
            let _ = remote!(core.endpoints.call(&endpoint, "pause_native_audio", json!({})));
            core.changed();
        }
        pause_followers(core, &mut io, true).await?;
        return Err("This song's service is disconnected. Reconnect it or replace the song with Improve Playlist.".into());
    }
    // Identical consecutive sources cannot be distinguished by a source-only engine report.
    // Let the first finish, then explicitly load the next occurrence.
    if next.as_deref() == Some(canonical_source.as_str()) { next = None; }
    let Some((status, reported_at, _, endpoint_instance)) = core.endpoints.status(&endpoint).await else {
        // A phone between networks keeps playing from its own download; hold the song for it.
        if core.endpoints.reconnecting(&endpoint).await {
            return Err(format!("Waiting for {} to reconnect", output.endpoint_name));
        }
        core.pause_disconnected_output();
        stop_soloist!();
        pause_followers(core, &mut io, false).await?;
        return Err(format!("Audio output {} is offline", output.endpoint_name));
    };

    let empty_engine = {
        let transport = core.transport();
        // Older outputs lack instance IDs, but a fresh idle engine also proves
        // that the previous playback process is gone.
        endpoint_instance.is_none()
            && transport.loaded.is_some()
            && transport.report_after.is_none_or(|after| reported_at >= after)
            && status.get("currentSource").is_some_and(Value::is_null)
            && status["buffering"] == false
            && status["ended"] != true
            && status["error"].is_null()
    };
    let restarted = core.transport().loaded.as_ref().is_some_and(|loaded|
        loaded.endpoint_id == endpoint && loaded.endpoint_instance != endpoint_instance);
    if restarted || empty_engine {
        core.pause_disconnected_output();
        stop_soloist!();
    }
    core.restore_orphaned(&endpoint, &output.device_id, &endpoint_instance, &canonical_source, next.as_deref(), &status);
    // The output's own changes the core knows of when it sends a command. The output ignores a
    // play, pause or seek decided before its latest own change.
    let known = || core.transport().known_control(&endpoint_instance);

    // A skip silences the song being left at once, before the next one is resolved and loaded.
    let silence = {
        let mut transport = core.transport();
        let skipped = std::mem::take(&mut transport.silence_skipped);
        transport.loaded.as_ref().filter(|_| skipped).map(|loaded| loaded.endpoint_id.clone())
    };
    if let Some(loaded_endpoint) = silence {
        // Without `control`, so a play the output made just before can't keep the old song going.
        let _ = remote!(core.endpoints.call(&loaded_endpoint, "pause_native_audio", json!({})));
        pause_followers(core, &mut io, false).await?;
        let mut transport = core.transport();
        // A previous that restarts the song is only a seek: play on after it, as before.
        if transport.playing && transport.pending_play.is_none() { transport.pending_play = Some(true); }
    }

    let mut source = canonical_source.clone();
    let mut live = false;
    let mut live_position = None;
    let spotify = track["provider"] == "spotify";
    let playing = core.transport().playing;
    if spotify && !playing && core.soloist_elsewhere() {
        // Spotify is playing in another session: leave it be until this one plays again.
        if core.transport().loaded.take().is_some() {
            let _ = remote!(core.endpoints.call(&endpoint, "pause_native_audio", json!({})));
        }
        let mut transport = core.transport();
        transport.pending_play = None;
        transport.buffering = false;
        return Ok(());
    }
    if let Some(manager) = core.soloist(spotify && playing) {
        let (generation, playing, position, seek, pinned, restarted, failed) = {
            let transport = core.transport();
            let same = transport.loaded.as_ref().filter(|loaded| loaded.track_source == canonical_source && loaded.generation == transport.generation);
            let restart = same.is_some_and(|loaded| loaded.endpoint_instance != endpoint_instance || loaded.endpoint_id != endpoint || loaded.device_id != output.device_id);
            let seek = transport.pending_seek.is_some();
            let failed = transport.failed_live_load.as_ref().is_some_and(|failed| failed.track_source == canonical_source && failed.generation == transport.generation && failed.endpoint_id == endpoint && failed.device_id == output.device_id && failed.endpoint_instance == endpoint_instance);
            (transport.generation, transport.playing, if transport.loaded.as_ref().is_some_and(|loaded| loaded.track_source != canonical_source) { 0.0 } else { transport.position_now() }, seek,
                same.filter(|_| !restart && !seek).map(|loaded| loaded.live), restart, failed)
        };
        // Renderer changes only at a track, seek, resume, or output initialization boundary.
        // A failed live stream retries through the existing session at its saved position.
        // Spotify's lossless stream goes to one output; a synced group plays it as High.
        live = !synced && track["provider"] == "spotify" && !failed && pinned.unwrap_or_else(|| status["livePcmV1"] == true && manager.readiness().is_ok());
        if live && !playing {
            let was_loaded = core.transport().loaded.take().is_some();
            if was_loaded { let _ = remote!(core.endpoints.call(&endpoint, "pause_native_audio", json!({}))); }
            provider!(manager.pause());
            let mut transport = core.transport();
            transport.pending_play = None; transport.pending_seek = None;
            transport.buffering = false;
            transport.duration = track["durationSeconds"].as_f64().unwrap_or(0.0);
            return Ok(());
        }
        if live {
            match provider!(manager.reserve(track["providerTrackId"].as_str().ok_or("Spotify track ID is missing")?, generation, &endpoint, position, track["durationSeconds"].as_f64().unwrap_or(0.0), seek || restarted)) {
                Ok(info) => {
                    live_position = Some(info.start_position_seconds);
                    source = crate::soloist::Manager::live_source(&info);
                    next = None;
                },
                Err(_) => {
                    // Reserve failed before a stream opened. Stop the old renderer before fallback.
                    provider!(manager.stop_playback());
                    let loaded = core.transport().loaded.take();
                    if let Some(loaded) = loaded {
                        let _ = remote!(core.endpoints.call(&loaded.endpoint_id, "pause_native_audio", json!({})));
                    }
                    live_position = Some(position);
                    live = false;
                }
            }
        }
        if !live { provider!(manager.stop_playback()); }
        if !spotify { core.release_soloist(); }
        // Optional lossless resolves its renderer at the next-track boundary.
        if manager.lossless_enabled() && queue["upcoming"].as_array().and_then(|items| items.first()).and_then(|item| track_of(&queue, item)).is_some_and(|track| track["provider"] == "spotify") { next = None; }
    }

    let (wanted, needs_device, position, autoplay, needs_load) = {
        let transport = core.transport();
        let wanted = Loaded { endpoint_id: endpoint.clone(), endpoint_instance: endpoint_instance.clone(), device_id: output.device_id.clone(), source: source.clone(), track_source: canonical_source.clone(), live, generation: transport.generation };
        let needs_device = empty_engine || transport.loaded.as_ref().is_none_or(|loaded| loaded.endpoint_id != endpoint || loaded.endpoint_instance != endpoint_instance || loaded.device_id != output.device_id);
        // A different song always starts at zero; a changed output resumes the same song.
        let changed_song = transport.loaded.as_ref().is_some_and(|loaded| loaded.track_source != canonical_source);
        let restarted = transport.loaded.as_ref().is_some_and(|loaded| loaded.endpoint_instance != endpoint_instance);
        let needs_load = empty_engine || transport.loaded.as_ref() != Some(&wanted);
        (wanted, needs_device, transport.pending_seek.or(live_position).unwrap_or_else(|| if changed_song { 0.0 } else if restarted || empty_engine { transport.position } else { transport.position_now() }), transport.playing, needs_load)
    };
    if needs_load {
        // A pause also stops an already executing, superseded autoplay load.
        if core.transport().pending_play == Some(false) {
            remote!(core.endpoints.call(&endpoint, "pause_native_audio", json!({ "control": known() })))?;
            core.transport().pending_play = None;
        }
        if needs_device {
            remote!(core.endpoints.call(&endpoint, "select_native_audio_device", json!({ "deviceId": output.device_id })))?;
        }
        let duration = track["durationSeconds"].as_f64().unwrap_or(0.0);
        // In a synced group, every output prepares the song and holds it for their start.
        let hold = {
            let mut transport = core.transport();
            if synced && autoplay { Some(transport.begin_sync(position, true)) } else {
                if synced { transport.sync = SyncPhase::Idle; }
                None
            }
        };
        if let Err(error) = remote!(core.endpoints
            .call(&endpoint, "load_native_audio", json!({ "source": source, "nextSource": next, "positionSeconds": position, "autoplay": autoplay, "control": known(), "sync": sync_args(hold) }))) {
            if live {
                if let Some(manager) = core.soloist(false) { provider!(manager.stop_playback()); }
                core.transport().failed_live_load = Some(wanted);
                core.transport().loaded = None;
                core.transport().position = position;
                core.transport().position_at = None;
            }
            return Err(error);
        }
        if core.endpoints.status(&endpoint).await.is_none_or(|(_, _, _, instance)| instance != endpoint_instance) {
            return Ok(());
        }
        if let Some(manager) = core.soloist(false) {
            if track["provider"] == "spotify" { manager.report_renderer(live); }
            else { manager.clear_effective_renderer(); }
        }
        {
            let mut transport = core.transport();
            transport.loaded = Some(wanted);
            transport.orphaned = None;
            transport.queued_next = Some(next.clone());
            transport.pending_play = None;
            transport.pending_seek = None;
            transport.duration = duration;
            // The output plays as its own latest change says, if it made one while this loaded.
            transport.buffering = transport.playing;
            transport.error = None;
            transport.set_position(position);
            transport.report_after = Some(Instant::now());
        }
        core.changed();
        if synced {
            drive_followers(core, &mut io, &source, &next).await?;
        }
        return Ok(());
    }

    let (pending_play, pending_seek, queued_next) = {
        let transport = core.transport();
        (transport.pending_play, transport.pending_seek, transport.queued_next.clone())
    };
    // In a synced group a seek or play while playing is a new start: every output prepares
    // from there and holds; a pause or a seek while paused goes to each at once.
    let hold = {
        let mut transport = core.transport();
        let starts = pending_play == Some(true) || pending_seek.is_some() && transport.playing && pending_play != Some(false);
        if synced && starts {
            let position = pending_seek.unwrap_or_else(|| transport.position_now());
            Some(transport.begin_sync(position, pending_seek.is_some()))
        } else {
            if synced && (pending_play == Some(false) || pending_seek.is_some()) { transport.sync = SyncPhase::Idle; }
            None
        }
    };
    if let Some(seek) = pending_seek {
        remote!(core.endpoints.call(&endpoint, "seek_native_audio", json!({ "positionSeconds": seek, "control": known(), "sync": sync_args(hold) })))?;
    }
    if let Some(playing) = pending_play {
        let command = if playing { "play_native_audio" } else { "pause_native_audio" };
        remote!(core.endpoints.call(&endpoint, command, json!({ "control": known(), "sync": sync_args(hold) })))?;
    }
    if synced && hold.is_none() {
        if pending_play == Some(false) {
            pause_followers(core, &mut io, false).await?;
        } else if let Some(seek) = pending_seek {
            seek_followers(core, &mut io, seek).await?;
        }
    }
    if pending_seek.is_some() || pending_play.is_some() {
        let mut transport = core.transport();
        transport.pending_play = None;
        transport.pending_seek = None;
        transport.report_after = Some(Instant::now());
    }
    if queued_next.as_ref() != Some(&next) {
        remote!(core.endpoints.call(&endpoint, "queue_native_audio", json!({ "source": next, "expectedSource": source })))?;
        core.transport().queued_next = Some(next.clone());
    }
    if synced {
        drive_followers(core, &mut io, &source, &next).await?;
        start_together(core, &mut io).await?;
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
        core.step_queue(QueueStep::Advance).await?;
        let count = {
        let mut transport = core.transport();
        if let Some(loaded) = transport.loaded.as_mut() {
            loaded.source = next.clone().unwrap_or_default();
            loaded.track_source = loaded.source.clone();
        }
        transport.queued_next = None;
        transport.set_position(status["currentTime"].as_f64().unwrap_or(0.0));
        let count = transport.playing && status["isPlaying"] == true && status["buffering"] != true;
        if count { transport.counted = Some((next.clone().unwrap_or_default(), transport.generation)); }
        count
        };
        if count && let Some(track) = queue["upcoming"].as_array().and_then(|items| items.first()).and_then(|item| track_of(&queue, item)) {
            core.record_play(track.clone()).await;
        }
        core.changed();
        return Ok(());
    }
    if playing_source.as_deref() != Some(source.as_str()) {
        return Ok(());
    }

    if track["provider"] == "spotify" {
        if let Some(manager) = core.soloist(false) { manager.report_renderer(live); }
        if live && status["error"].is_string() {
            // Stop and retry the same generation. No queue advance and no new history entry.
            if let Some(manager) = core.soloist(false) { provider!(manager.stop_playback()); }
            let loaded = core.transport().loaded.take();
            let _ = remote!(core.endpoints.call(&endpoint, "pause_native_audio", json!({})));
            let mut transport = core.transport();
            transport.position = status["currentTime"].as_f64().unwrap_or(transport.position);
            transport.position_at = None;
            transport.failed_live_load = loaded;
            transport.buffering = true;
            return Ok(());
        }
    }
    let ended = status["ended"].as_bool().unwrap_or(false);
    let engine_playing = status["isPlaying"].as_bool().unwrap_or(false);
    let buffering = status["buffering"].as_bool().unwrap_or(false);
    let count = {
        let mut transport = core.transport();
        let before = (transport.buffering, transport.error.clone(), transport.duration, transport.audio_quality.clone());
        transport.position = status["currentTime"].as_f64().unwrap_or(transport.position);
        transport.position_at = Some(sampled_at);
        core.positions.send_modify(|count| *count += 1);
        if let Some(duration) = status["duration"].as_f64().filter(|duration| *duration > 0.0) {
            transport.duration = duration;
        }
        transport.buffering = transport.playing && (buffering || !engine_playing && !ended);
        transport.error = status["error"].as_str().map(str::to_owned);
        transport.audio_quality = status["audioQuality"].clone();
        if track["provider"] == "spotify" {
            if !transport.audio_quality.is_object() { transport.audio_quality = json!({}); }
            transport.audio_quality["playbackBackend"] = json!(if live { "soloist" } else { "librespot" });
            transport.audio_quality["requestedQuality"] = json!(if live { "lossless" } else { "high" });
            if let Some(manager) = &core.spotify_playback { transport.audio_quality["preferredQuality"] = json!(manager.status().preferred_quality); }
            if live { transport.audio_quality["sourceFormatVerified"] = json!(false); }
        }
        let after = (transport.buffering, transport.error.clone(), transport.duration, transport.audio_quality.clone());
        let generation = transport.generation;
        let count = transport.playing && engine_playing && !buffering && transport.counted.as_ref() != Some(&(canonical_source.clone(), generation));
        if count {
            transport.counted = Some((canonical_source.clone(), generation));
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
    if ended && core.transport().playing {
        // The song finished with nothing queued behind it in the engine: move on, or stop.
        // Whether another song follows; otherwise the queue has ended.
        let moved = core.step_queue(QueueStep::AdvanceOrFinish).await?.is_some_and(|patch| !patch.current.is_null());
        let mut transport = core.transport();
        transport.set_position(0.0);
        if !moved {
            transport.playing = false;
            transport.loaded = None;
        } else {
            transport.generation += 1;
            transport.buffering = transport.playing;
        }
        drop(transport);
        core.changed();
    }
    Ok(())
}

// ---------- Playing on several outputs in step ----------

fn sync_args(epoch: Option<u64>) -> Value {
    epoch.map_or(Value::Null, |epoch| json!({ "epoch": epoch }))
}

/// The group's start, as each output is told it: song position `position` is heard at `at_ms`.
fn start_args(epoch: u64, at_ms: f64, position: f64, resync_ms: u64) -> Value {
    json!({ "epoch": epoch, "atServerMs": at_ms, "positionSeconds": position, "sentAtServerMs": server_time_ms(), "groupResyncMs": resync_ms })
}

/// A command to a following output. Its failure is that output's alone: it never stops the
/// group, and the output is tried again a little later. False when it failed.
async fn follower_call(core: &Core, io: &mut OutputOperation<'_>, endpoint: &str, command: &str, args: Value) -> Result<bool, String> {
    match io.interruptible(core.endpoints.call(endpoint, command, args)).await? {
        Ok(_) => Ok(true),
        Err(error) => {
            eprintln!("A synced output couldn't {command}: {error}");
            if let Some(follower) = core.transport().follower(endpoint) {
                follower.loaded = None;
                follower.held = 0;
                follower.started = 0;
                follower.failed_at = Some(Instant::now());
            }
            Ok(false)
        }
    }
}

/// Pauses the following outputs; `unload` also forgets what they had, for nothing to play.
async fn pause_followers(core: &Core, io: &mut OutputOperation<'_>, unload: bool) -> Result<(), String> {
    let playing: Vec<String> = {
        let mut transport = core.transport();
        if transport.followers.is_empty() { return Ok(()); }
        transport.sync = SyncPhase::Idle;
        transport.followers.iter_mut().filter_map(|follower| {
            follower.held = 0;
            follower.started = 0;
            let loaded = if unload { follower.queued_next = None; follower.loaded.take().is_some() } else { follower.loaded.is_some() };
            loaded.then(|| follower.address.clone())
        }).collect()
    };
    if playing.is_empty() { return Ok(()); }
    let pauses = playing.iter().map(|endpoint| core.endpoints.call(endpoint, "pause_native_audio", json!({})));
    let _ = io.interruptible(futures_util::future::join_all(pauses)).await?;
    Ok(())
}

/// A seek while paused goes to every following output as it is.
async fn seek_followers(core: &Core, io: &mut OutputOperation<'_>, position: f64) -> Result<(), String> {
    let loaded: Vec<String> = core.transport().followers.iter()
        .filter(|follower| follower.loaded.is_some())
        .map(|follower| follower.address.clone())
        .collect();
    for endpoint in loaded {
        follower_call(core, io, &endpoint, "seek_native_audio", json!({ "positionSeconds": position })).await?;
    }
    Ok(())
}

/// The group's timeline as the leading output keeps it, while it plays `source`: when it
/// hears which song position, on the server's clock.
async fn leader_anchor(core: &Core, source: &str) -> Option<(f64, f64)> {
    let endpoint = core.transport().output.as_ref()?.endpoint_id.clone();
    let (status, ..) = core.endpoints.status(&endpoint).await?;
    if status["currentSource"].as_str() != Some(source) { return None; }
    let anchor = &status["syncAnchor"];
    Some((anchor["atServerMs"].as_f64()?, anchor["positionSeconds"].as_f64()?))
}

/// Brings each following output to what the group plays: the song, prepared and held for the
/// group's start, or joined in step when the group already plays; paused with it otherwise.
async fn drive_followers(core: &Core, io: &mut OutputOperation<'_>, source: &str, next: &Option<String>) -> Result<(), String> {
    let followers: Vec<(String, Output)> = core.transport().followers.iter().map(|follower| (follower.address.clone(), follower.output.clone())).collect();
    for (address, output) in followers {
        let endpoint = address.as_str();
        let Some((status, _, _, instance)) = core.endpoints.status(endpoint).await else {
            // Out of reach: it starts afresh when it's back.
            if let Some(follower) = core.transport().follower(endpoint) {
                follower.loaded = None;
                follower.queued_next = None;
                follower.held = 0;
                follower.started = 0;
            }
            continue;
        };
        // An app from before synced playback can't keep time with the rest.
        if status["syncV1"] != true { continue; }
        let (phase, generation, position_now, follower) = {
            let mut transport = core.transport();
            let (phase, generation, position) = (transport.sync, transport.generation, transport.position_now());
            let Some(follower) = transport.follower(endpoint) else { continue };
            if follower.failed_at.is_some_and(|at| at.elapsed() < FOLLOWER_RETRY) { continue; }
            // It moved on to the queued song by itself, without a gap, as the others did.
            let advanced = follower.loaded.as_ref().is_some_and(|loaded| loaded.track_source != source && loaded.generation == generation && loaded.endpoint_instance == instance)
                && status["currentSource"].as_str() == Some(source)
                && follower.queued_next.as_ref().is_some_and(|queued| queued.as_deref() == Some(source));
            if advanced {
                if let Some(loaded) = follower.loaded.as_mut() {
                    loaded.source = source.to_owned();
                    loaded.track_source = source.to_owned();
                }
                follower.queued_next = None;
            }
            (phase, generation, position, follower.clone())
        };
        let wanted = Loaded { endpoint_id: endpoint.to_owned(), endpoint_instance: instance.clone(), device_id: output.device_id.clone(), source: source.to_owned(), track_source: source.to_owned(), live: false, generation };
        let needs_device = follower.loaded.as_ref().is_none_or(|loaded| loaded.endpoint_instance != instance || loaded.device_id != output.device_id);
        let needs_load = follower.loaded.as_ref() != Some(&wanted);
        let load = |position: f64, autoplay: bool, epoch: Option<u64>| json!({ "source": source, "nextSource": next, "positionSeconds": position.max(0.0), "autoplay": autoplay, "sync": sync_args(epoch) });
        macro_rules! call {
            ($command:expr, $args:expr) => { if !follower_call(core, io, endpoint, $command, $args).await? { continue; } };
        }
        let select = json!({ "deviceId": output.device_id });
        let (held, started) = match phase {
            SyncPhase::Preparing { epoch, position, seek, .. } if needs_load || follower.held != epoch => {
                if needs_device { call!("select_native_audio_device", select); }
                if needs_load {
                    call!("load_native_audio", load(position, true, Some(epoch)));
                } else if seek || (status["currentTime"].as_f64().unwrap_or(position) - position).abs() > RESUME_IN_PLACE_SECONDS {
                    call!("seek_native_audio", json!({ "positionSeconds": position, "sync": sync_args(Some(epoch)) }));
                } else {
                    // Resumes from where it paused; the start lines that up with the rest.
                    call!("play_native_audio", json!({ "sync": sync_args(Some(epoch)) }));
                }
                (epoch, follower.started)
            }
            SyncPhase::Running { epoch, resync_ms, .. } if needs_load || follower.started != epoch => {
                // Prepares from where the group will be once it's ready, then lines up with it.
                let Some((at_ms, position)) = leader_anchor(core, source).await else { continue };
                let join = position + (server_time_ms() + SYNC_JOIN_LEAD_MS - at_ms) / 1000.0;
                if needs_device { call!("select_native_audio_device", select); }
                if needs_load {
                    call!("load_native_audio", load(join, true, Some(epoch)));
                } else {
                    call!("seek_native_audio", json!({ "positionSeconds": join.max(0.0), "sync": sync_args(Some(epoch)) }));
                }
                call!("sync_native_audio", start_args(epoch, at_ms, position, resync_ms));
                (epoch, epoch)
            }
            SyncPhase::Idle if needs_load => {
                if needs_device { call!("select_native_audio_device", select); }
                call!("load_native_audio", load(position_now, false, None));
                (0, 0)
            }
            _ => (follower.held, follower.started),
        };
        let queued = {
            let mut transport = core.transport();
            let Some(follower) = transport.follower(endpoint) else { continue };
            if needs_load {
                follower.loaded = Some(wanted);
                follower.queued_next = Some(next.clone());
            }
            follower.held = held;
            follower.started = started;
            follower.failed_at = None;
            follower.loaded.is_some().then(|| follower.queued_next.clone())
        };
        // The song after this one, ready to follow on without a gap like the others.
        if let Some(queued) = queued && queued.as_ref() != Some(next) {
            call!("queue_native_audio", json!({ "source": next, "expectedSource": source }));
            if let Some(follower) = core.transport().follower(endpoint) { follower.queued_next = Some(next.clone()); }
        }
    }
    Ok(())
}

/// Starts the group once every output is ready (or the slowest has had long enough): each is
/// told when the group hears the start position. That leaves the longest resync delay any of
/// them needs, so none skips the start of the song to keep up with the others.
async fn start_together(core: &Core, io: &mut OutputOperation<'_>) -> Result<(), String> {
    let (epoch, position, since, members) = {
        let transport = core.transport();
        let SyncPhase::Preparing { epoch, position, since, .. } = transport.sync else { return Ok(()) };
        let mut members: Vec<String> = transport.loaded.iter().map(|loaded| loaded.endpoint_id.clone()).collect();
        members.extend(transport.followers.iter()
            .filter(|follower| follower.loaded.is_some() && follower.held == epoch)
            .map(|follower| follower.address.clone()));
        (epoch, position, since, members)
    };
    let (mut needed, mut longest, mut waiting) = (0_u64, 0_u64, false);
    for endpoint in &members {
        let Some((status, ..)) = core.endpoints.status(endpoint).await else { continue };
        if status["syncReady"].as_u64() == Some(epoch) {
            needed = needed.max(status["syncResyncDelayMs"].as_u64().unwrap_or(0));
            longest = longest.max(status["resyncDelayMs"].as_u64().unwrap_or(0));
        } else if status["error"].is_null() {
            // A failed output doesn't hold up the rest.
            waiting = true;
        }
    }
    if waiting && since.elapsed() < SYNC_READY_TIMEOUT { return Ok(()); }
    let (needed, longest) = (needed.min(10_000), longest.min(10_000));
    let at_ms = server_time_ms() + SYNC_START_MARGIN_MS + needed as f64;
    let args = start_args(epoch, at_ms, position, longest);
    let starts = members.iter().map(|endpoint| core.endpoints.call(endpoint, "sync_native_audio", args.clone()));
    let results = io.interruptible(futures_util::future::join_all(starts)).await?;
    let mut transport = core.transport();
    if !matches!(transport.sync, SyncPhase::Preparing { epoch: current, .. } if current == epoch) { return Ok(()); }
    transport.sync = SyncPhase::Running { epoch, at_ms, position, resync_ms: longest };
    // Heard from the start time on; until then the position stays where the group starts.
    transport.position = position;
    transport.position_at = Some(server_instant(at_ms));
    let leader = transport.output.as_ref().map(|output| output.endpoint_id.clone());
    for (endpoint, result) in members.iter().zip(results) {
        if result.is_ok() {
            if let Some(follower) = transport.follower(endpoint) { follower.started = epoch; }
        } else if Some(endpoint) == leader.as_ref() {
            // The leading output missed its start: it loads again and the group starts anew.
            transport.loaded = None;
        } else if let Some(follower) = transport.follower(endpoint) {
            // It joins the playing group instead.
            follower.started = 0;
        }
    }
    drop(transport);
    core.changed();
    Ok(())
}

// ---------- Sessions ----------

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: String,
    name: String,
}

/// Every session this server runs. `main` always exists; the others are made and removed by apps.
pub struct Sessions {
    state: Arc<UserState>,
    endpoints: Arc<Endpoints>,
    spotify_playback: Option<Arc<crate::soloist::Manager>>,
    /// The session using the Spotify renderer, if one has claimed it (`Core::soloist`).
    soloist_owner: SyncMutex<Option<String>>,
    sessions: SyncMutex<Vec<(SessionInfo, Shared)>>,
    path: std::path::PathBuf,
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn session_name(name: &str) -> Result<String, Response> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_SESSION_NAME {
        return Err(error(StatusCode::BAD_REQUEST, format!("A session name is 1 to {MAX_SESSION_NAME} characters")));
    }
    Ok(name.to_owned())
}

impl Sessions {
    pub fn open(state: Arc<UserState>, endpoints: Arc<Endpoints>, spotify_playback: Option<Arc<crate::soloist::Manager>>) -> Arc<Self> {
        let path = state.directory().join(SESSIONS_FILE);
        let mut saved: Vec<SessionInfo> = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        saved.retain(|info| valid_session_id(&info.id));
        saved.truncate(MAX_SESSIONS);
        if !saved.iter().any(|info| info.id == MAIN_SESSION) {
            saved.insert(0, SessionInfo { id: MAIN_SESSION.into(), name: "Main".into() });
        }
        let sessions = Arc::new(Self {
            state, endpoints, spotify_playback,
            soloist_owner: SyncMutex::new(None),
            sessions: SyncMutex::new(Vec::new()),
            path,
        });
        let opened = saved.into_iter().map(|info| { let core = Core::open(&info.id, &sessions); (info, core) }).collect();
        *sessions.list() = opened;
        let weak = Arc::downgrade(&sessions);
        sessions.endpoints.on_report(Box::new(move |endpoint, status, instance, sampled_at| {
            let Some(sessions) = weak.upgrade() else { return };
            for core in sessions.cores() {
                if core.transport().output.as_ref().is_some_and(|output| output.endpoint_id == endpoint) {
                    core.adopt_control(endpoint, status, instance, sampled_at);
                    core.wake.notify_one();
                }
            }
        }));
        sessions
    }

    fn list(&self) -> std::sync::MutexGuard<'_, Vec<(SessionInfo, Shared)>> {
        self.sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn cores(&self) -> Vec<Shared> {
        self.list().iter().map(|(_, core)| core.clone()).collect()
    }

    fn core(&self, id: &str) -> Option<Shared> {
        self.list().iter().find(|(info, _)| info.id == id).map(|(_, core)| core.clone())
    }

    pub fn save_transports(&self) {
        for core in self.cores() { core.save_transport(); }
    }

    fn save(&self) -> Result<(), String> {
        let infos: Vec<SessionInfo> = self.list().iter().map(|(info, _)| info.clone()).collect();
        let bytes = serde_json::to_vec(&infos).map_err(|error| error.to_string())?;
        crate::server_config::write_private(&self.path, &bytes)
    }

    async fn summaries(&self) -> Vec<SessionSummary> {
        let list: Vec<(SessionInfo, Shared)> = self.list().clone();
        let mut summaries = Vec::with_capacity(list.len());
        for (info, core) in list {
            let queue = core.queue().await;
            let track = current_and_next(&queue).0.map(|(track, _)| json!({
                "title": track["title"], "artist": track["artist"], "album": track["album"], "cover": track["cover"],
            }));
            let transport = core.transport();
            summaries.push(SessionSummary { id: info.id, name: info.name, playing: transport.playing, output: transport.output.clone(), outputs: transport.outputs(), track });
        }
        summaries
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    id: String,
    name: String,
    playing: bool,
    output: Option<Output>,
    /// Every output the session plays on, in step: `output` first.
    outputs: Vec<Output>,
    /// The current song, for showing what each session is playing.
    track: Option<Value>,
}

#[derive(Deserialize)]
struct SessionName {
    name: String,
}

async fn list_sessions(State(sessions): State<Arc<Sessions>>) -> Json<Vec<SessionSummary>> {
    Json(sessions.summaries().await)
}

async fn create_session(State(sessions): State<Arc<Sessions>>, Json(body): Json<SessionName>) -> Response {
    let name = match session_name(&body.name) { Ok(name) => name, Err(response) => return response };
    let id = crate::server_config::random_hex(6);
    {
        let mut list = sessions.list();
        if list.len() >= MAX_SESSIONS {
            return error(StatusCode::BAD_REQUEST, format!("A server runs at most {MAX_SESSIONS} sessions"));
        }
        let core = Core::open(&id, &sessions);
        list.push((SessionInfo { id: id.clone(), name }, core));
    }
    if let Err(message) = sessions.save() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, message);
    }
    let created = sessions.summaries().await.into_iter().find(|summary| summary.id == id);
    Json(created).into_response()
}

async fn rename_session(State(sessions): State<Arc<Sessions>>, axum::extract::Path(id): axum::extract::Path<String>, Json(body): Json<SessionName>) -> Response {
    let name = match session_name(&body.name) { Ok(name) => name, Err(response) => return response };
    let core = {
        let mut list = sessions.list();
        let Some((info, core)) = list.iter_mut().find(|(info, _)| info.id == id) else {
            return error(StatusCode::NOT_FOUND, "That session no longer exists");
        };
        info.name = name;
        core.clone()
    };
    if let Err(message) = sessions.save() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, message);
    }
    core.changed();
    Json(sessions.summaries().await).into_response()
}

/// Removes a session: its output stops, and its queue and transport are forgotten.
async fn delete_session(State(sessions): State<Arc<Sessions>>, axum::extract::Path(id): axum::extract::Path<String>) -> Response {
    if id == MAIN_SESSION {
        return error(StatusCode::BAD_REQUEST, "The main session can't be removed");
    }
    let core = {
        let mut list = sessions.list();
        let Some(index) = list.iter().position(|(info, _)| info.id == id) else {
            return error(StatusCode::NOT_FOUND, "That session no longer exists");
        };
        list.remove(index).1
    };
    if let Err(message) = sessions.save() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, message);
    }
    core.closed.store(true, Ordering::Relaxed);
    core.commands.send_modify(|revision| *revision += 1);
    core.changed();
    let _operation = core.operation.lock().await;
    let owned_soloist = {
        let mut owner = sessions.soloist_owner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if owner.as_deref() == Some(id.as_str()) { owner.take().is_some() } else { false }
    };
    if owned_soloist && let Some(manager) = &sessions.spotify_playback {
        let _ = manager.stop_playback().await;
        manager.clear_effective_renderer();
    }
    let loaded: Vec<String> = {
        let transport = core.transport();
        transport.loaded.iter().map(|loaded| loaded.endpoint_id.clone())
            .chain(transport.followers.iter().filter(|follower| follower.loaded.is_some()).map(|follower| follower.address.clone()))
            .collect()
    };
    for endpoint in loaded {
        let _ = core.endpoints.call(&endpoint, "pause_native_audio", json!({})).await;
    }
    let _ = core.state.update(&core.queue_key, |_| Ok((None, ()))).await;
    let _ = std::fs::remove_file(&core.transport_path);
    Json(sessions.summaries().await).into_response()
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
        assert_eq!(current.unwrap().1, "/api/providers/tidal/tracks/2/playlist.m3u8?q=1");
        assert_eq!(next.unwrap(), "C:/Music/c.flac");
        assert_eq!(source_of(&json!({ "provider": "local", "providerTrackId": "hash.flac", "audio": "/api/music/local/files/hash.flac", "playbackKind": "direct" })).as_deref(), Some("/api/music/local/files/hash.flac"));
        // The same song written by apps reaching the server at different addresses is one source.
        let at = |audio: &str| source_of(&json!({ "provider": "qobuz", "audio": audio, "playbackKind": "direct" }));
        assert_eq!(at("http://127.0.0.1:43749/api/providers/qobuz/tracks/1/stream").as_deref(), Some("/api/providers/qobuz/tracks/1/stream"));
        assert_eq!(at("http://127.0.0.1:33923/api/providers/qobuz/tracks/1/stream"), at("http://192.168.1.20:38147/api/providers/qobuz/tracks/1/stream"));
        assert_eq!(at("http://[::1]:38147/api/a?access_token=x&q=1").as_deref(), Some("/api/a?q=1"));
        assert_eq!(at("http://ambra.local:38147/api/a?access_token=x").as_deref(), Some("/api/a"));
        // A provider's own URL is left whole.
        assert_eq!(at("https://cdn.example.com/api/a.flac").as_deref(), Some("https://cdn.example.com/api/a.flac"));
        assert_eq!(source_of(&json!({ "provider": "tidal", "audio": "http://127.0.0.1:9/api/t/manifest.mpd?x=1", "playbackKind": "dash" })).as_deref(), Some("/api/t/playlist.m3u8?x=1"));
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
        load_delay: Arc<SyncMutex<Duration>>,
        workers: Vec<tokio::task::JoinHandle<()>>,
    }

    impl Harness {
        async fn start() -> Self { Self::start_backend(false).await }

        async fn playing_output() -> Self {
            let harness = Self::start().await;
            *harness.instance.lock().unwrap() = Some("first-process".into());
            harness.report(json!({})).await;
            harness.post("/api/session/command", json!({ "action": "output", "output": { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" } })).await;
            harness.post("/api/session/queue", json!({ "base": 0, "playTrackId": "a", "queue": { "version": 1, "history": [], "current": item("a"), "upcoming": [item("b")], "tracks": [track("a"), track("b")] } })).await;
            harness.wait_for_command("load_native_audio").await;
            harness.report(json!({ "currentSource": source("a"), "currentTime": 42.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
            tokio::time::timeout(Duration::from_secs(2), async {
                while harness.core.transport().position != 42.0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await.unwrap();
            harness
        }

        async fn stop_workers(&mut self) {
            for worker in self.workers.drain(..) {
                worker.abort();
                let _ = worker.await;
            }
        }

        async fn start_backend(soloist: bool) -> Self {
            let directory = std::env::temp_dir().join(format!("ambra-core-{}-{}", std::process::id(), crate::server_config::random_hex(4)));
            let state = Arc::new(UserState::at(directory.join("user-state.v1.json")));
            let endpoints = Arc::new(Endpoints::default());
            let sessions = Sessions::open(state.clone(), endpoints.clone(), soloist.then(|| crate::soloist::tests::manager(&directory, true)));
            let core = sessions.core(MAIN_SESSION).unwrap();
            let app: Router = Router::new()
                .merge(crate::endpoints::router(endpoints.clone()))
                .merge(router(sessions))
                .layer(axum::Extension(crate::access::Caller { client_id: None }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let mut harness = Self { base, http: reqwest::Client::new(), state, core, instance: Arc::default(), received: Arc::default(), status: Arc::default(), sending: Arc::default(), load_delay: Arc::default(), workers: Vec::new() };
            harness.report(json!({})).await;
            harness.serve_commands();
            harness
        }

        async fn report(&self, mut status: Value) {
            if status.get("livePcmV1").is_none() { status["livePcmV1"] = json!(true); }
            let _sending = self.sending.lock().await;
            *self.status.lock().unwrap() = status.clone();
            let instance = self.instance.lock().unwrap().clone();
            self.http.post(format!("{}/api/endpoints/desk/presence", self.base))
                .json(&json!({ "name": "Desk", "instanceId": instance, "devices": [{ "id": "spk", "name": "Speakers" }], "status": status }))
                .send().await.unwrap();
        }

        /// The output app: answers every command at once, like an idle engine would.
        fn serve_commands(&mut self) {
            let (base, http, status, instance, sending) = (self.base.clone(), self.http.clone(), self.status.clone(), self.instance.clone(), self.sending.clone());
            // A real output reports continuously, including after a command acknowledgement.
            self.workers.push(tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let _sending = sending.lock().await;
                    let status = status.lock().unwrap().clone();
                    let instance = instance.lock().unwrap().clone();
                    let _ = http.post(format!("{base}/api/endpoints/desk/presence"))
                        .json(&json!({ "name": "Desk", "instanceId": instance, "status": status })).send().await;
                }
            }));
            let (base, http, received, status, load_delay) = (self.base.clone(), self.http.clone(), self.received.clone(), self.status.clone(), self.load_delay.clone());
            self.workers.push(tokio::spawn(async move {
                loop {
                    let Ok(response) = http.get(format!("{base}/api/endpoints/desk/commands?wait=5")).send().await else { continue };
                    for command in response.json::<Vec<Value>>().await.unwrap_or_default() {
                        received.lock().unwrap().push((command["command"].as_str().unwrap().to_owned(), command["args"].clone()));
                        if command["command"] == "load_native_audio" {
                            *status.lock().unwrap() = json!({
                                "currentSource": command["args"]["source"],
                                "currentTime": command["args"]["positionSeconds"],
                                "buffering": true, "ended": false, "error": null, "livePcmV1": true
                            });
                        }
                        let delay = if command["command"] == "load_native_audio" { *load_delay.lock().unwrap() } else { Duration::ZERO };
                        let (http, base) = (http.clone(), base.clone());
                        tokio::spawn(async move {
                            tokio::time::sleep(delay).await;
                            http.post(format!("{base}/api/endpoints/desk/results"))
                                .json(&json!({ "id": command["id"], "ok": true, "value": null }))
                                .send().await.unwrap();
                        });
                    }
                }
            }));
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

        async fn wait_for_command_after(&self, command: &str, skip: usize) {
            for _ in 0..80 {
                if self.received.lock().unwrap().iter().skip(skip).any(|(received, _)| received == command) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("timed out waiting for {command}: {:?}", self.received.lock().unwrap());
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

    impl Drop for Harness {
        fn drop(&mut self) {
            for worker in &self.workers { worker.abort(); }
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

    /// What the core sends an output for track `id`: the path its full `audio` URL names.
    fn source(id: &str) -> String {
        format!("/api/providers/qobuz/tracks/{id}/stream")
    }

    /// The commands the output received after the first `skip` of them.
    fn received_after(h: &Harness, skip: usize) -> Vec<(String, Value)> {
        h.received.lock().unwrap()[skip..].to_vec()
    }

    /// Another output app, one that plays in synced groups. Prepares at once whatever it's
    /// asked to hold, then reports itself ready for that start, needing `resync_ms` first.
    struct SyncedOutput {
        received: Arc<SyncMutex<Vec<(String, Value)>>>,
        workers: Vec<tokio::task::JoinHandle<()>>,
    }

    impl SyncedOutput {
        fn start(base: &str, id: &'static str, resync_ms: u64) -> Self {
            let http = reqwest::Client::new();
            let status = Arc::new(SyncMutex::new(json!({ "syncV1": true, "currentSource": null, "buffering": false, "ended": false, "error": null })));
            let received: Arc<SyncMutex<Vec<(String, Value)>>> = Arc::default();
            let mut workers = Vec::new();
            let (presence_base, presence_http, presence_status) = (base.to_owned(), http.clone(), status.clone());
            workers.push(tokio::spawn(async move {
                loop {
                    let status = presence_status.lock().unwrap().clone();
                    let _ = presence_http.post(format!("{presence_base}/api/endpoints/{id}/presence"))
                        .json(&json!({ "name": id, "instanceId": id, "devices": [{ "id": "spk", "name": "Speakers" }], "status": status })).send().await;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }));
            let (base, recorded) = (base.to_owned(), received.clone());
            workers.push(tokio::spawn(async move {
                loop {
                    let Ok(response) = http.get(format!("{base}/api/endpoints/{id}/commands?wait=5")).send().await else { continue };
                    for command in response.json::<Vec<Value>>().await.unwrap_or_default() {
                        let (name, args) = (command["command"].as_str().unwrap().to_owned(), command["args"].clone());
                        recorded.lock().unwrap().push((name.clone(), args.clone()));
                        {
                            let mut status = status.lock().unwrap();
                            if name == "load_native_audio" {
                                status["currentSource"] = args["source"].clone();
                                status["currentTime"] = args["positionSeconds"].clone();
                            }
                            if let Some(epoch) = args["sync"]["epoch"].as_u64() {
                                status["buffering"] = json!(true);
                                status["syncReady"] = json!(epoch);
                                status["syncResyncDelayMs"] = json!(resync_ms);
                                status["resyncDelayMs"] = json!(resync_ms);
                            }
                            if name == "sync_native_audio" {
                                status.as_object_mut().unwrap().remove("syncReady");
                            }
                        }
                        let _ = http.post(format!("{base}/api/endpoints/{id}/results"))
                            .json(&json!({ "id": command["id"], "ok": true, "value": null })).send().await;
                    }
                }
            }));
            Self { received, workers }
        }

        fn commands(&self, name: &str) -> Vec<Value> {
            self.received.lock().unwrap().iter().filter(|(command, _)| command == name).map(|(_, args)| args.clone()).collect()
        }
    }

    impl Drop for SyncedOutput {
        fn drop(&mut self) {
            for worker in &self.workers { worker.abort(); }
        }
    }

    fn commands(h: &Harness, name: &str) -> Vec<Value> {
        h.received.lock().unwrap().iter().filter(|(command, _)| command == name).map(|(_, args)| args.clone()).collect()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_synced_group_waits_for_every_output_then_starts_them_together_after_the_longest_resync() {
        let h = Harness::start().await;
        h.report(json!({ "syncV1": true })).await;
        let den = SyncedOutput::start(&h.base, "den", 1500);
        eventually!("the second output to report", h.core.endpoints.online("den").await);
        let outputs = json!([
            { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" },
            { "endpointId": "den", "deviceId": "spk", "endpointName": "Den", "deviceName": "Speakers" },
        ]);
        let view = h.post("/api/session/command", json!({ "action": "outputs", "outputs": outputs })).await;
        assert_eq!(view["outputs"].as_array().unwrap().len(), 2);
        h.post("/api/session/queue", json!({ "base": 0, "playTrackId": "a", "queue": { "version": 1, "history": [], "current": item("a"), "upcoming": [item("b")], "tracks": [track("a"), track("b")] } })).await;
        h.wait_for_command("load_native_audio").await;
        eventually!("the second output to load", !den.commands("load_native_audio").is_empty());
        let epoch = commands(&h, "load_native_audio")[0]["sync"]["epoch"].as_u64().expect("the leading output holds its start");
        let den_load = &den.commands("load_native_audio")[0];
        assert_eq!(den_load["sync"]["epoch"].as_u64(), Some(epoch), "both hold for the same start");
        assert_eq!(den_load["source"], source("a"));
        assert_eq!(den_load["autoplay"], true);

        // The leading output isn't ready yet: nobody starts.
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(den.commands("sync_native_audio").is_empty() && commands(&h, "sync_native_audio").is_empty());

        h.report(json!({ "currentSource": source("a"), "currentTime": 0.0, "isPlaying": false, "buffering": true, "ended": false, "syncReady": epoch, "syncResyncDelayMs": 0, "resyncDelayMs": 0 })).await;
        h.wait_for_command("sync_native_audio").await;
        eventually!("the second output's start", !den.commands("sync_native_audio").is_empty());
        let (desk_start, den_start) = (commands(&h, "sync_native_audio")[0].clone(), den.commands("sync_native_audio")[0].clone());
        assert_eq!(desk_start["atServerMs"], den_start["atServerMs"], "one start time for the group");
        assert_eq!(desk_start["epoch"].as_u64(), Some(epoch));
        assert_eq!(desk_start["positionSeconds"], 0.0);
        assert_eq!(desk_start["groupResyncMs"], 1500);
        let lead = desk_start["atServerMs"].as_f64().unwrap() - desk_start["sentAtServerMs"].as_f64().unwrap();
        assert!(lead >= 1500.0 + SYNC_START_MARGIN_MS - 50.0, "the start leaves the longest resync delay: {lead}");
        // Running once every output has answered its start.
        eventually!("the group to run", matches!(h.core.transport().sync, SyncPhase::Running { .. }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pausing_a_synced_group_pauses_every_output_and_choosing_one_output_releases_the_rest() {
        let h = Harness::start().await;
        h.report(json!({ "syncV1": true })).await;
        let den = SyncedOutput::start(&h.base, "den", 0);
        eventually!("the second output to report", h.core.endpoints.online("den").await);
        h.post("/api/session/command", json!({ "action": "outputs", "outputs": [
            { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" },
            { "endpointId": "den", "deviceId": "spk", "endpointName": "Den", "deviceName": "Speakers" },
        ] })).await;
        h.post("/api/session/queue", json!({ "base": 0, "playTrackId": "a", "queue": { "version": 1, "history": [], "current": item("a"), "upcoming": [], "tracks": [track("a")] } })).await;
        eventually!("the second output to load", !den.commands("load_native_audio").is_empty());
        h.post("/api/session/command", json!({ "action": "pause" })).await;
        eventually!("the second output to pause", !den.commands("pause_native_audio").is_empty());
        let view = h.post("/api/session/command", json!({ "action": "output", "output": { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" } })).await;
        assert_eq!(view["outputs"].as_array().unwrap().len(), 1);
        assert!(h.core.transport().followers.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_output_on_one_computer_plays_on_a_player_of_its_own_there() {
        let h = Harness::start().await;
        let outputs = json!([
            { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" },
            { "endpointId": "desk", "deviceId": "hp", "endpointName": "Desk", "deviceName": "Headphones" },
        ]);
        h.report(json!({ "syncV1": true })).await;
        let refused = h.http.post(format!("{}/api/session/command", h.base)).json(&json!({ "action": "outputs", "outputs": outputs })).send().await.unwrap();
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST, "an app with one player plays one output");

        h.report(json!({ "syncV1": true, "satellitesV1": true })).await;
        let view = h.post("/api/session/command", json!({ "action": "outputs", "outputs": outputs })).await;
        assert_eq!(view["outputs"].as_array().unwrap().len(), 2);
        h.post("/api/session/queue", json!({ "base": 0, "playTrackId": "a", "queue": { "version": 1, "history": [], "current": item("a"), "upcoming": [], "tracks": [track("a")] } })).await;
        eventually!("the second output to load", commands(&h, "load_native_audio").iter().any(|args| args["satellite"] == "hp"));
        let selected = commands(&h, "select_native_audio_device");
        assert!(selected.iter().any(|args| args["satellite"] == "hp" && args["deviceId"] == "hp"), "its own player plays the headphones: {selected:?}");
        assert!(commands(&h, "load_native_audio").iter().any(|args| args["satellite"].is_null()), "the computer's own player plays the speakers");

        h.post("/api/session/command", json!({ "action": "volume", "volume": 20.0, "output": outputs[1] })).await;
        let volumes = commands(&h, "set_native_audio_volume");
        assert_eq!(volumes.len(), 1);
        assert_eq!(volumes[0]["satellite"], "hp");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn each_output_in_a_group_has_its_own_volume() {
        let h = Harness::start().await;
        h.report(json!({ "syncV1": true })).await;
        let den = SyncedOutput::start(&h.base, "den", 0);
        eventually!("the second output to report", h.core.endpoints.online("den").await);
        let den_speakers = json!({ "endpointId": "den", "deviceId": "spk", "endpointName": "Den", "deviceName": "Speakers" });
        h.post("/api/session/command", json!({ "action": "outputs", "outputs": [
            { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" },
            den_speakers.clone(),
        ] })).await;
        h.post("/api/session/command", json!({ "action": "volume", "volume": 30.0, "output": den_speakers })).await;
        eventually!("the second output's volume", !den.commands("set_native_audio_volume").is_empty());
        assert_eq!(den.commands("set_native_audio_volume")[0]["volume"], 30.0);
        assert!(commands(&h, "set_native_audio_volume").is_empty(), "the leading output keeps its own");
        let elsewhere = h.http.post(format!("{}/api/session/command", h.base)).json(&json!({ "action": "volume", "volume": 30.0,
            "output": { "endpointId": "attic", "deviceId": "spk", "endpointName": "Attic", "deviceName": "Speakers" } })).send().await.unwrap();
        assert_eq!(elsewhere.status(), StatusCode::BAD_REQUEST, "only an output playing can be set");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_output_that_cannot_keep_time_is_refused_a_place_in_a_group() {
        let h = Harness::start().await;
        let den = SyncedOutput::start(&h.base, "den", 0);
        eventually!("the second output to report", h.core.endpoints.online("den").await);
        let refused = h.http.post(format!("{}/api/session/command", h.base)).json(&json!({ "action": "outputs", "outputs": [
            { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" },
            { "endpointId": "den", "deviceId": "spk", "endpointName": "Den", "deviceName": "Speakers" },
        ] })).send().await.unwrap();
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        assert!(refused.json::<Value>().await.unwrap()["error"].as_str().unwrap().contains("Desk"));
        assert!(h.core.transport().followers.is_empty());
        drop(den);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_skip_pauses_the_song_being_left_before_loading_the_next() {
        let h = Harness::playing_output().await;
        let before = h.received.lock().unwrap().len();
        h.post("/api/session/command", json!({ "action": "next" })).await;
        h.wait_for_command_after("load_native_audio", before).await;
        let commands: Vec<String> = received_after(&h, before).into_iter().map(|(command, _)| command).collect();
        let pause = commands.iter().position(|command| command == "pause_native_audio").expect("the old song is paused");
        let load = commands.iter().position(|command| command == "load_native_audio").unwrap();
        assert!(pause < load, "paused before the next song loads: {commands:?}");
        let (_, pause_args) = &received_after(&h, before)[pause];
        assert!(pause_args.get("control").is_none(), "never overruled by the output's own latest play");
        let (_, load_args) = received_after(&h, before).into_iter().find(|(command, _)| command == "load_native_audio").unwrap();
        assert_eq!(load_args["source"], source("b"));
        assert_eq!(load_args["autoplay"], true);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_previous_that_restarts_pauses_then_seeks_and_plays_on() {
        let h = Harness::playing_output().await;
        let before = h.received.lock().unwrap().len();
        h.post("/api/session/command", json!({ "action": "previous" })).await;
        h.wait_for_command_after("play_native_audio", before).await;
        let commands: Vec<String> = received_after(&h, before).into_iter().map(|(command, _)| command).collect();
        assert_eq!(commands, ["pause_native_audio", "seek_native_audio", "play_native_audio"]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn playing_a_new_song_or_shuffling_pauses_the_song_being_left_first() {
        let h = Harness::playing_output().await;
        let before = h.received.lock().unwrap().len();
        let base = h.http.get(format!("{}/api/session", h.base)).send().await.unwrap().json::<Value>().await.unwrap()["queueRevision"].clone();
        h.post("/api/session/queue", json!({ "base": base, "playTrackId": "b", "queue": { "version": 1, "history": [], "current": item("b"), "upcoming": [item("a")], "tracks": [track("a"), track("b")] } })).await;
        h.wait_for_command_after("load_native_audio", before).await;
        let commands: Vec<String> = received_after(&h, before).into_iter().map(|(command, _)| command).collect();
        let pause = commands.iter().position(|command| command == "pause_native_audio").expect("the old song is paused");
        let load = commands.iter().position(|command| command == "load_native_audio").unwrap();
        assert!(pause < load, "paused before the new song loads: {commands:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_next_with_nothing_after_leaves_the_song_playing() {
        let h = Harness::playing_output().await;
        h.post("/api/session/command", json!({ "action": "next" })).await;
        h.wait_for_command_after("load_native_audio", 1).await;
        h.report(json!({ "currentSource": source("b"), "currentTime": 10.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let before = h.received.lock().unwrap().len();
        h.post("/api/session/command", json!({ "action": "next" })).await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(received_after(&h, before).iter().all(|(command, _)| command != "pause_native_audio"));
        assert!(h.core.transport().playing);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn pause_during_provider_retry_does_not_wait_or_get_overwritten() {
        let h = Harness::start_backend(true).await;
        let manager = h.core.spotify_playback.as_ref().unwrap();
        let provider = crate::soloist::tests::hold_playback_operation(manager).await;
        h.core.transport().error = Some("fixture capture failure".into());
        let mut started = h.core.commands.subscribe();
        let (http, base) = (h.http.clone(), h.base.clone());
        let retry = tokio::spawn(async move {
            http.post(format!("{base}/api/session/command")).json(&json!({"action":"play"})).send().await.unwrap()
        });
        started.changed().await.unwrap();
        let paused = tokio::time::timeout(Duration::from_millis(400), h.post("/api/session/command", json!({"action":"pause"}))).await
            .expect("provider cleanup must not own the session operation lock");
        assert_eq!(paused["playing"], false);
        drop(provider);
        tokio::time::timeout(Duration::from_secs(2), retry).await.unwrap().unwrap();
        assert!(!h.core.transport().playing, "a superseded retry must not restore Play");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn queue_readers_share_an_immutable_snapshot_and_changes_invalidate_it() {
        let h = Harness::start().await;
        let first = h.core.queue().await;
        let same = h.core.queue().await;
        assert!(Arc::ptr_eq(&first, &same));
        h.core.change_queue(|queue| { queue["current"] = item("a"); Ok((true, ())) }).await.unwrap();
        let changed = h.core.queue().await;
        assert!(!Arc::ptr_eq(&first, &changed));
        assert!(first["current"].is_null());
        assert_eq!(changed["current"]["globalTrackId"], "a");
        assert_eq!(queue_revision(&changed), queue_revision(&first) + 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn controls_interrupt_a_slow_load_without_committing_stale_results() {
        let h = Harness::start().await;
        *h.load_delay.lock().unwrap() = Duration::from_secs(2);
        h.post("/api/session/command", json!({ "action": "output", "output": { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" } })).await;
        let queued = json!({ "version": 1, "history": [], "current": item("a"), "upcoming": [item("b")], "tracks": [track("a"), track("b")] });
        h.post("/api/session/queue", json!({ "base": 0, "queue": queued, "playTrackId": "a" })).await;
        h.wait_for_command("load_native_audio").await;
        let started = Instant::now();
        for body in [json!({ "action": "pause" }), json!({ "action": "next" }), json!({ "action": "seek", "positionSeconds": 37.0 })] {
            let view = tokio::time::timeout(Duration::from_millis(400), h.post("/api/session/command", body)).await
                .expect("a control must not wait behind remote preparation");
            assert_eq!(view["playing"], false);
        }
        eprintln!("CONTROL_LATENCY_MS {}", started.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(h.queue().await["current"]["globalTrackId"], "b");
        tokio::time::sleep(Duration::from_millis(2300)).await;
        let transport = h.core.transport();
        assert!(!transport.playing, "late autoplay result must not undo pause");
        assert!(transport.loaded.as_ref().is_none_or(|loaded| loaded.track_source == source("b")), "obsolete track must never commit");
        assert_eq!(transport.position, 37.0, "late load must not undo seek");
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
            assert_eq!(args["autoplay"], false);
        }
        assert!(!h.core.transport().playing);
        h.report(json!({ "currentSource": source("a"), "currentTime": 65.0, "duration": 200.0, "isPlaying": false, "buffering": false, "ended": false })).await;
        eventually!("resumed report", h.core.transport().position == 65.0);
        assert_eq!(h.core.transport().generation, generation);
        assert_eq!(h.queue().await, queue);
        assert_eq!(h.history().await, history);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reopening_the_output_keeps_the_current_song_paused_and_clears_offline_error() {
        check_reopened_output(true, false).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reopening_a_legacy_output_keeps_a_playing_song_paused() {
        check_reopened_output(false, false).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reopening_a_legacy_output_keeps_a_paused_song_paused() {
        check_reopened_output(false, true).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn reopening_an_identified_output_keeps_a_paused_song_paused() {
        check_reopened_output(true, true).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn only_the_active_outputs_departure_pauses_playback_until_explicit_resume() {
        let mut harness = Harness::playing_output().await;
        harness.post("/api/endpoints/other/presence", json!({ "name": "Other", "instanceId": "other-process", "status": {} })).await;
        harness.post("/api/endpoints/other/departure", json!({ "instanceId": "other-process" })).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(harness.core.transport().playing);
        let queue = harness.queue().await;
        let history = harness.history().await;
        let generation = harness.core.transport().generation;
        harness.stop_workers().await;
        harness.post("/api/endpoints/desk/departure", json!({ "instanceId": "first-process" })).await;
        eventually!("active output departure to pause playback", !harness.core.transport().playing);
        {
            let transport = harness.core.transport();
            assert!(!transport.buffering);
            assert!(transport.loaded.is_none());
            assert_eq!(transport.position, 42.0);
        }
        harness.received.lock().unwrap().clear();
        *harness.instance.lock().unwrap() = Some("second-process".into());
        harness.report(json!({ "currentSource": null, "currentTime": 0.0, "isPlaying": false, "buffering": false, "ended": false })).await;
        harness.serve_commands();
        harness.wait_for_command("load_native_audio").await;
        eventually!("paused output to reload", harness.core.transport().loaded.is_some());
        assert!(harness.received.lock().unwrap().iter().filter(|(command, _)| command == "load_native_audio").all(|(_, args)| args["autoplay"] == false));
        assert!(!harness.core.transport().playing);
        harness.report(json!({ "currentSource": source("a"), "currentTime": 42.0, "duration": 200.0, "isPlaying": false, "buffering": false, "ended": false })).await;
        let resumed = harness.post("/api/session/command", json!({ "action": "play" })).await;
        assert_eq!(resumed["playing"], true);
        harness.wait_for_command("play_native_audio").await;
        assert_eq!(harness.core.transport().generation, generation);
        assert_eq!(harness.queue().await, queue);
        assert_eq!(harness.history().await, history);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_crashed_output_pauses_after_presence_expires() {
        let mut harness = Harness::playing_output().await;
        let queue = harness.queue().await;
        harness.stop_workers().await;
        // Past the presence timeout the output may only be changing networks; its song is kept.
        tokio::time::sleep(Duration::from_secs(9)).await;
        assert!(harness.core.transport().playing, "a reconnecting output keeps its song");
        assert!(harness.core.transport().error.as_deref().is_some_and(|error| error.starts_with("Waiting for")));
        tokio::time::timeout(crate::endpoints::RECONNECT_GRACE, async {
            while harness.core.transport().playing {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.expect("a vanished client must pause once the reconnect grace runs out");
        assert_eq!(harness.core.transport().position, 42.0);
        assert!(!harness.core.transport().buffering);
        assert_eq!(harness.queue().await, queue);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_output_back_from_a_network_change_keeps_playing_without_a_reload() {
        let mut harness = Harness::playing_output().await;
        let queue = harness.queue().await;
        let generation = harness.core.transport().generation;
        harness.stop_workers().await;
        tokio::time::sleep(Duration::from_secs(9)).await;
        assert!(harness.core.transport().playing);
        harness.received.lock().unwrap().clear();
        // The same process reports again, still playing from what it downloaded.
        harness.report(json!({ "currentSource": source("a"), "currentTime": 51.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        harness.serve_commands();
        eventually!("the waiting message to clear", harness.core.transport().error.is_none());
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(harness.core.transport().playing);
        assert_eq!(harness.core.transport().generation, generation);
        assert!(!harness.received.lock().unwrap().iter().any(|(command, _)| command == "load_native_audio" || command == "pause_native_audio"));
        assert_eq!(harness.queue().await, queue);
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
    async fn adding_to_the_queue_from_an_app_at_another_address_keeps_the_current_song_playing() {
        let h = Harness::start().await;
        h.post("/api/session/command", json!({ "action": "output", "output": { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" } })).await;
        let queued = json!({ "version": 1, "history": [], "current": item("a"), "upcoming": [], "tracks": [track("a")] });
        h.post("/api/session/queue", json!({ "base": 0, "queue": queued, "playTrackId": "a" })).await;
        h.wait_for_command("load_native_audio").await;
        h.report(json!({ "currentSource": source("a"), "currentTime": 64.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        eventually!("the position to arrive", h.core.transport().position == 64.0);

        // An app launched since reaches the server through a new bridge port and writes every
        // song it sends with that address, then adds a song.
        let moved = |id: &str| {
            let mut track = track(id);
            track["audio"] = json!(format!("http://127.0.0.1:43749/api/providers/qobuz/tracks/{id}/stream?access_token=t"));
            track
        };
        let revision = h.queue().await["revision"].as_u64().unwrap();
        let added = json!({ "version": 1, "history": [], "current": item("a"), "upcoming": [item("b")], "tracks": [moved("a"), moved("b")] });
        h.post("/api/session/queue", json!({ "base": revision, "queue": added })).await;
        h.wait_for_command("queue_native_audio").await;
        tokio::time::sleep(Duration::from_millis(300)).await;

        let received = h.received.lock().unwrap().clone();
        assert_eq!(received.iter().filter(|(command, _)| command == "load_native_audio").count(), 1, "the playing song is not loaded again");
        let queued_next = &received.iter().find(|(command, _)| command == "queue_native_audio").unwrap().1;
        assert_eq!(queued_next["source"], source("b"));
        assert!(h.core.transport().position >= 64.0, "the song keeps its place");
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
    /// What an app does with a patch: the queue it had becomes the queue the server has.
    fn patched(queue: &Value, patch: &Value) -> Value {
        let count = |key: &str| patch[key].as_u64().unwrap() as usize;
        let list = |key: &str| patch[key].as_array().unwrap().clone();
        let history = queue["history"].as_array().unwrap();
        let upcoming = queue["upcoming"].as_array().unwrap();
        let mut next = queue.clone();
        next["history"] = Value::Array([&history[count("historyDropFront")..history.len() - count("historyDropBack")], &list("historyPush")].concat());
        next["upcoming"] = Value::Array([list("upcomingUnshift").as_slice(), &upcoming[count("upcomingDropFront")..]].concat());
        next["current"] = patch["current"].clone();
        next["revision"] = patch["revision"].clone();
        next
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_step_through_the_queue_is_sent_as_a_patch_that_makes_the_same_queue() {
        let h = Harness::start().await;
        // A full history, so moving on also drops its oldest entry.
        let played: Vec<Value> = (0..MAX_QUEUE_HISTORY).map(|index| {
            let mut entry = item("a");
            entry["historyId"] = json!(format!("h{index}"));
            entry["playedAt"] = json!("2026-01-01T00:00:00.000Z");
            entry
        }).collect();
        h.post("/api/session/queue", json!({ "base": 0, "queue": { "version": 1, "history": played, "current": item("a"), "upcoming": [item("b"), item("c")], "tracks": [track("a"), track("b"), track("c")] } })).await;
        let get = |query: &'static str| { let (http, base) = (h.http.clone(), h.base.clone()); async move { http.get(format!("{base}/api/session{query}")).send().await.unwrap().json::<Value>().await.unwrap() } };
        let mut known = get("").await["queue"].clone();

        // Next, next (the last song), the end of the queue, then back twice.
        for step in [QueueStep::Advance, QueueStep::Advance, QueueStep::AdvanceOrFinish, QueueStep::Rewind, QueueStep::Rewind] {
            let revision = known["revision"].as_u64().unwrap();
            assert!(h.core.step_queue(step).await.unwrap().is_some());
            let view: Value = h.http.get(format!("{}/api/session?queue={revision}&patches=1", h.base)).send().await.unwrap().json().await.unwrap();
            assert!(view.get("queue").is_none(), "a patch replaces the queue");
            assert_eq!(view["queuePatch"]["base"], revision);
            known = patched(&known, &view["queuePatch"]);
            assert_eq!(known, get("").await["queue"], "the patched queue is the server's");
            assert_eq!(known, h.queue().await, "and the one it saved");
        }
        assert_eq!(known["history"].as_array().unwrap().len(), MAX_QUEUE_HISTORY - 2);
        assert_eq!(known["current"]["globalTrackId"], "b");
        assert!(h.core.step_queue(QueueStep::Advance).await.unwrap().is_some());
        assert!(h.core.step_queue(QueueStep::Advance).await.unwrap().is_none(), "nothing after the last song");

        // An app further behind, or one that never asked for patches, gets the whole queue.
        let behind: Value = h.http.get(format!("{}/api/session?queue=1&patches=1", h.base)).send().await.unwrap().json().await.unwrap();
        assert!(behind.get("queuePatch").is_none());
        assert_eq!(behind["queue"], h.queue().await);
        let revision = queue_revision(&h.queue().await);
        h.core.step_queue(QueueStep::Rewind).await.unwrap();
        let plain: Value = h.http.get(format!("{}/api/session?queue={revision}", h.base)).send().await.unwrap().json().await.unwrap();
        assert!(plain.get("queuePatch").is_none());
        assert_eq!(plain["queue"], h.queue().await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_stream_patches_a_step_and_leaves_any_other_queue_to_be_asked_for() {
        use futures_util::StreamExt;
        let h = Harness::start().await;
        let queue = json!({ "version": 1, "history": [], "current": item("a"), "upcoming": [item("b")], "tracks": [track("a"), track("b")] });
        h.post("/api/session/queue", json!({ "base": 0, "queue": queue })).await;
        let mut lines = h.http.get(format!("{}/api/session/stream?patches=1", h.base)).send().await.unwrap().bytes_stream();
        let mut buffered = Vec::new();
        let mut next = async || -> Value {
            loop {
                if let Some(end) = buffered.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = buffered.drain(..=end).collect();
                    return serde_json::from_slice(&line).unwrap();
                }
                let chunk = tokio::time::timeout(Duration::from_secs(5), lines.next()).await.unwrap().unwrap().unwrap();
                buffered.extend_from_slice(&chunk);
            }
        };
        // The app has no queue yet: it asks for it, compressed, rather than getting it here.
        let first = next().await;
        assert_eq!(first["queueRevision"], 1);
        assert!(first.get("queue").is_none() && first.get("queuePatch").is_none());

        h.core.step_queue(QueueStep::Advance).await.unwrap();
        let stepped = loop { let line = next().await; if line["queueRevision"] == 2 { break line; } };
        assert_eq!(stepped["queuePatch"]["base"], 1);
        assert_eq!(stepped["queuePatch"]["current"]["globalTrackId"], "b");
        assert!(stepped.get("queue").is_none());

        // Another app replaces the queue: only the news of it travels on the stream.
        let mut replaced = h.queue().await;
        replaced["upcoming"] = json!([item("a")]);
        h.post("/api/session/queue", json!({ "base": 2, "queue": replaced })).await;
        let news = loop { let line = next().await; if line["queueRevision"] == 3 { break line; } };
        assert!(news.get("queue").is_none() && news.get("queuePatch").is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_queue_of_thousands_of_songs_is_accepted() {
        let h = Harness::start().await;
        let ids: Vec<String> = (0..6000).map(|index| format!("song-{index}")).collect();
        let queue = json!({ "version": 1, "history": [], "current": item(&ids[0]), "upcoming": ids[1..].iter().map(|id| item(id)).collect::<Vec<_>>(), "tracks": ids.iter().map(|id| track(id)).collect::<Vec<_>>() });
        assert!(queue.to_string().len() > 2 * 1024 * 1024, "larger than the framework's default body limit");
        let response = h.http.post(format!("{}/api/session/queue", h.base)).json(&json!({ "base": 0, "queue": queue })).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(h.queue().await["upcoming"].as_array().unwrap().len(), 5999);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_queue_changed_outside_the_core_is_read_again() {
        let h = Harness::start().await;
        h.core.change_queue(|queue| { queue["current"] = item("a"); Ok((true, ())) }).await.unwrap();
        let kept = h.core.queue().await;
        // Another key changing leaves the kept queue as it is.
        h.state.update("ambra.library-order.v1", |_| Ok((Some(json!(["a"]).to_string()), ()))).await.unwrap();
        h.core.refresh_queue().await;
        assert!(Arc::ptr_eq(&kept, &h.core.queue().await));
        // The queue itself replaced in the shared state (an imported local song, say) isn't.
        h.state.update(QUEUE_KEY, |saved| {
            let mut queue: Value = serde_json::from_str(saved.unwrap()).unwrap();
            queue["current"] = item("b");
            Ok((Some(queue.to_string()), ()))
        }).await.unwrap();
        eventually!("the replaced queue", h.core.queue().await["current"]["globalTrackId"] == "b");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_counted_play_is_described_by_the_one_entry_it_moves() {
        let h = Harness::start().await;
        for id in ["a", "b", "a"] {
            let before: Value = h.history().await.map_or_else(|| json!({ "version": 1, "entries": [] }), |saved| serde_json::from_str(&saved).unwrap());
            h.core.record_play(track(id)).await;
            // What an app does with the patch: the entry goes first, replacing the song's old one.
            let entry = h.state.latest_patch(HISTORY_KEY).unwrap()["play"].clone();
            let mut entries = vec![entry.clone()];
            entries.extend(before["entries"].as_array().unwrap().iter().filter(|other| other["track"]["globalId"] != entry["track"]["globalId"]).cloned());
            let after: Value = serde_json::from_str(&h.history().await.unwrap()).unwrap();
            assert_eq!(after, json!({ "version": 1, "entries": entries }));
        }
        let after: Value = serde_json::from_str(&h.history().await.unwrap()).unwrap();
        assert_eq!(after["entries"][0]["playCount"], 2);
        assert_eq!(after["entries"].as_array().unwrap().len(), 2);
    }

    fn spotify_track(id: &str, spotify: &str) -> Value {
        let mut track = track(id);
        track["provider"] = json!("spotify"); track["providerTrackId"] = json!(spotify);
        track["audio"] = json!(format!("http://127.0.0.1:38147/api/providers/spotify/tracks/{spotify}/stream"));
        track
    }
    async fn latest_live(h: &Harness, except: Option<&str>) -> String {
        for _ in 0..80 {
            let source = h.received.lock().unwrap().iter().rev().find(|(command, _)| command == "load_native_audio").and_then(|(_, args)| args["source"].as_str().map(str::to_owned));
            if let Some(source) = source && source.starts_with("/api/playback/live/") && except != Some(source.as_str()) { return source; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no fresh live source");
    }
    #[tokio::test]
    async fn soloist_pause_seek_and_late_reports_preserve_queue_and_history() {
        let h = Harness::start_backend(true).await;
        let queued = json!({ "version": 1, "history": [], "current": item("a"), "upcoming": [item("b")], "tracks": [spotify_track("a", "0123456789abcdefghijkl"), spotify_track("b", "abcdefghijkl0123456789")] });
        h.post("/api/session/command", json!({ "action": "output", "output": { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" } })).await;
        h.post("/api/session/queue", json!({ "queue": queued, "base": 0, "playTrackId": "a" })).await;
        let first = latest_live(&h, None).await;
        h.report(json!({ "currentSource": first, "currentTime": 10.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        eventually!("first real play", h.history().await.is_some());
        let history = h.history().await;
        let generation = h.core.transport().generation;
        h.post("/api/session/command", json!({ "action": "pause" })).await;
        h.wait_for_command("pause_native_audio").await;
        h.report(json!({ "currentSource": first, "currentTime": 200.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": true })).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(h.queue().await["current"]["globalTrackId"], "a"); assert!(!h.core.transport().playing);
        h.post("/api/session/command", json!({ "action": "seek", "positionSeconds": 45.0 })).await;
        h.post("/api/session/command", json!({ "action": "play" })).await;
        let resumed = latest_live(&h, Some(&first)).await;
        h.report(json!({ "currentSource": resumed, "currentTime": 45.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        eventually!("resume position", h.core.transport().position >= 45.0);
        assert_eq!(h.core.transport().generation, generation); assert_eq!(h.history().await, history);
        h.post("/api/session/command", json!({ "action": "seek", "positionSeconds": 80.0 })).await;
        let sought = latest_live(&h, Some(&resumed)).await;
        assert_ne!(sought, resumed);
        h.report(json!({ "currentSource": resumed, "currentTime": 200.0, "isPlaying": true, "buffering": false, "ended": true })).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(h.queue().await["current"]["globalTrackId"], "a");
        h.post("/api/session/command", json!({ "action": "next" })).await;
        let next = latest_live(&h, Some(&sought)).await;
        h.report(json!({ "currentSource": sought, "currentTime": 200.0, "isPlaying": true, "buffering": false, "ended": true })).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(h.queue().await["current"]["globalTrackId"], "b");
        h.report(json!({ "currentSource": next, "currentTime": 200.0, "isPlaying": false, "buffering": false, "ended": true })).await;
        eventually!("queue finishes through the core", h.queue().await["current"].is_null());
    }

    #[tokio::test]
    async fn soloist_output_restart_keeps_position_generation_and_history() {
        let h = Harness::start_backend(true).await;
        *h.instance.lock().unwrap() = Some("first-process".into());
        h.report(json!({})).await;
        h.post("/api/session/command", json!({ "action": "output", "output": { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" } })).await;
        h.post("/api/session/queue", json!({ "base": 0, "playTrackId": "a", "queue": { "version": 1, "history": [], "current": item("a"), "upcoming": [], "tracks": [spotify_track("a", "0123456789abcdefghijkl")] } })).await;
        let first = latest_live(&h, None).await;
        h.report(json!({ "currentSource": first, "currentTime": 64.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        eventually!("play counted", h.history().await.is_some());
        let history = h.history().await;
        let generation = h.core.transport().generation;
        *h.instance.lock().unwrap() = Some("second-process".into());
        h.report(json!({ "currentSource": null, "currentTime": 0.0, "isPlaying": false, "buffering": false, "ended": false })).await;
        eventually!("restarted output to pause Spotify playback", !h.core.transport().playing && !h.core.transport().buffering);
        assert_eq!(h.core.transport().position, 64.0);
        h.post("/api/session/command", json!({ "action": "play" })).await;
        let resumed = latest_live(&h, Some(&first)).await;
        assert_ne!(resumed, first);
        h.report(json!({ "currentSource": resumed, "currentTime": 64.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        eventually!("position restored", h.core.transport().position >= 64.0);
        assert_eq!(h.core.transport().generation, generation);
        assert_eq!(h.history().await, history);
        assert_eq!(h.queue().await["current"]["globalTrackId"], "a");
    }

    #[tokio::test]
    async fn automatic_upgrade_waits_for_next_track_and_unsupported_output_uses_high() {
        use crate::soloist::tests::configure_enabled;
        let h = Harness::start_backend(true).await;
        let manager = h.core.spotify_playback.as_ref().unwrap();
        configure_enabled(manager, false).await;
        h.post("/api/session/command", json!({ "action": "output", "output": { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" } })).await;
        h.post("/api/session/queue", json!({ "base": 0, "playTrackId": "a", "queue": { "version": 1, "history": [], "current": item("a"), "upcoming": [item("b")], "tracks": [spotify_track("a", "0123456789abcdefghijkl"), spotify_track("b", "1123456789abcdefghijkl")] } })).await;
        h.wait_for_command("load_native_audio").await;
        eventually!("High loaded", h.core.transport().loaded.as_ref().is_some_and(|l| !l.live));
        let canonical = h.core.transport().loaded.as_ref().unwrap().source.clone();
        assert!(h.core.transport().queued_next.as_ref().is_some_and(|next| next.is_some()), "ordinary lossy playback retains preloading");
        h.report(json!({ "currentSource": canonical, "currentTime": 10.0, "duration": 200.0, "isPlaying": true, "buffering": false, "livePcmV1": true })).await;
        eventually!("play counted", h.history().await.is_some());
        let history = h.history().await;
        configure_enabled(manager, true).await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!h.core.transport().loaded.as_ref().unwrap().live);
        assert_eq!(h.history().await, history);
        h.post("/api/session/command", json!({ "action": "next" })).await;
        let live = latest_live(&h, None).await;
        h.report(json!({ "currentSource": live, "currentTime": 20.0, "duration": 200.0, "isPlaying": true, "buffering": false, "livePcmV1": true })).await;
        eventually!("Lossless selected", h.core.transport().audio_quality["requestedQuality"] == "lossless");
        // An output restart is a safe initialization boundary; old outputs need no live support.
        *h.instance.lock().unwrap() = Some("unsupported-output".into());
        h.report(json!({ "currentSource": null, "isPlaying": false, "buffering": false, "livePcmV1": false })).await;
        eventually!("unsupported output fallback", h.core.transport().loaded.as_ref().is_some_and(|l| !l.live));
    }

    #[tokio::test]
    async fn soloist_installation_failure_never_reloads_playing_librespot() {
        use crate::soloist::tests::{configure_enabled, fail_installation};
        let h = Harness::start_backend(true).await;
        let manager = h.core.spotify_playback.as_ref().unwrap();
        configure_enabled(manager, false).await;
        h.post("/api/session/command", json!({ "action": "output", "output": { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" } })).await;
        h.post("/api/session/queue", json!({ "base": 0, "playTrackId": "a", "queue": { "version": 1, "history": [], "current": item("a"), "upcoming": [], "tracks": [spotify_track("a", "0123456789abcdefghijkl")] } })).await;
        eventually!("Librespot loaded", h.core.transport().loaded.as_ref().is_some_and(|l| !l.live));
        let source = h.core.transport().loaded.as_ref().unwrap().source.clone();
        h.report(json!({ "currentSource": source, "currentTime": 25.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        eventually!("history counted", h.history().await.is_some());
        let history = h.history().await;
        let generation = h.core.transport().generation;
        let loads = h.received.lock().unwrap().iter().filter(|(command, _)| command == "load_native_audio").count();
        configure_enabled(manager, true).await;
        fail_installation(manager).await;
        h.report(json!({ "currentSource": source, "currentTime": 26.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        eventually!("Librespot continues", h.core.transport().position >= 26.0);
        {
            let transport = h.core.transport();
            let loaded = transport.loaded.as_ref().unwrap();
            assert!(!loaded.live);
            assert_eq!(loaded.source, source);
            assert_eq!(transport.generation, generation);
            assert!(transport.playing);
            assert_eq!(transport.audio_quality["requestedQuality"], "high");
        }
        assert_eq!(h.received.lock().unwrap().iter().filter(|(command, _)| command == "load_native_audio").count(), loads);
        assert_eq!(h.history().await, history);
        assert_eq!(h.queue().await["current"]["globalTrackId"], "a");
    }

    #[tokio::test]
    async fn capture_failure_retries_high_without_queue_or_history_duplication() {
        let h = Harness::start_backend(true).await;
        h.post("/api/session/command", json!({ "action": "output", "output": { "endpointId": "desk", "deviceId": "spk", "endpointName": "Desk", "deviceName": "Speakers" } })).await;
        h.post("/api/session/queue", json!({ "base": 0, "playTrackId": "a", "queue": { "version": 1, "history": [], "current": item("a"), "upcoming": [], "tracks": [spotify_track("a", "0123456789abcdefghijkl")] } })).await;
        let live = latest_live(&h, None).await;
        h.report(json!({ "currentSource": live, "currentTime": 25.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false })).await;
        eventually!("history counted", h.history().await.is_some());
        let history = h.history().await;
        let generation = h.core.transport().generation;
        h.report(json!({ "currentSource": live, "currentTime": 26.0, "isPlaying": false, "buffering": false, "error": "Capture interrupted" })).await;
        eventually!("High recovery loaded", h.core.transport().loaded.as_ref().is_some_and(|l| !l.live));
        let canonical = h.core.transport().loaded.as_ref().unwrap().source.clone();
        h.report(json!({ "currentSource": canonical, "currentTime": 27.0, "duration": 200.0, "isPlaying": true, "buffering": false, "ended": false, "error": null })).await;
        eventually!("truthful fallback quality", h.core.transport().audio_quality["requestedQuality"] == "high");
        assert_eq!(h.core.transport().generation, generation);
        assert_eq!(h.history().await, history);
        assert_eq!(h.queue().await["current"]["globalTrackId"], "a");
    }

}
