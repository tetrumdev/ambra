//! Server-owned listening state, shared by every client of this server. Each key remembers
//! the revision that last changed it, so a write is refused only when it would overwrite a
//! key another client changed since this one last saw it; clients edit different keys
//! freely. Clients follow other clients' changes by asking for what changed since their
//! revision, waiting briefly for news. Disk replacement completes before a write is
//! acknowledged.
//!
//! The file is read and checked once; after that every read answers from the copy kept in
//! memory, and a write replaces that copy only once the file has been replaced. Only this
//! process writes the file (`server_process::lock`).

use std::{collections::BTreeMap, fs, io::Write, path::PathBuf};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Query, State},
    http::{StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, watch};

const MAX_STATE_BYTES: usize = 64 * 1024 * 1024;
const MAX_WAIT_SECONDS: u64 = 30;
const KEYS: &[&str] = &[
    "ambra.playlists.v1",
    "ambra.queue.v1",
    "ambra.playback.v1",
    "ambra.listening-history.v1",
    "ambra.library-order.v1",
    "ambra.removed-library-tracks.v1",
    // Settings and per-song choices that follow the listener between devices.
    "ambra.ui-preferences.v1",
    "ambra.album-versions.v1",
    "ambra.lyrics-sync.v1",
    "ambra.lyrics-autosync.v2",
    "ambra.lyrics-autosync-samples.v1",
    "ambra.lyrics-autosync-noticed.v1",
    "ambra.dsp-presets.v1",
];
/// Keys whose shape the app owns; the server only checks they hold a JSON object or list.
const OPAQUE_KEYS: &[&str] = &[
    "ambra.ui-preferences.v1",
    "ambra.album-versions.v1",
    "ambra.lyrics-sync.v1",
    "ambra.lyrics-autosync.v2",
    "ambra.lyrics-autosync-samples.v1",
    "ambra.lyrics-autosync-noticed.v1",
    "ambra.dsp-presets.v1",
];

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    revision: u64,
    values: BTreeMap<String, String>,
    #[serde(default, rename = "lastWriteId")]
    last_write_id: Option<String>,
    /// The revision at which each key last changed, including keys since removed. Keys
    /// saved before this was tracked count as unchanged since revision 0.
    #[serde(default, rename = "keyRevisions")]
    key_revisions: BTreeMap<String, u64>,
}

type Changes = BTreeMap<String, Option<String>>;

impl Snapshot {
    fn changed_since(&self, key: &str, revision: u64) -> bool {
        self.key_revisions.get(key).is_some_and(|changed| *changed > revision)
    }

    /// Keys changed after `revision`, other than those in `except`; a removed key maps to `None`.
    fn changes_since(&self, revision: u64, except: &Changes) -> Changes {
        self.key_revisions
            .iter()
            .filter(|(key, changed)| **changed > revision && !except.contains_key(*key))
            .map(|(key, _)| (key.clone(), self.values.get(key).cloned()))
            .collect()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Patch {
    revision: u64,
    #[serde(rename = "writeId")]
    write_id: String,
    changes: BTreeMap<String, Option<String>>,
    /// The revision each changed key was based on, when older than `revision`: a client
    /// can hear of other changes while editing a key, without having seen them in that key.
    #[serde(default)]
    bases: BTreeMap<String, u64>,
}

pub struct UserState {
    path: PathBuf,
    /// The saved state, once read: one reader or writer at a time. `None` until the file has
    /// been read successfully, so an unreadable file keeps being reported rather than replaced.
    saved: std::sync::Arc<Mutex<Option<Snapshot>>>,
    /// The latest revision, for clients waiting to hear of a change.
    revision: watch::Sender<u64>,
    /// How the server's own latest change to a key can be made from the value before it,
    /// for apps that have that value: a play moves one entry of a history of thousands.
    patches: std::sync::Mutex<BTreeMap<String, KeyPatch>>,
}

/// One key's latest change as a patch: what an app with the value as of any revision from
/// `base` up to (not including) `revision` does to get the value at `revision`.
#[derive(Clone)]
struct KeyPatch {
    base: u64,
    revision: u64,
    patch: Value,
}

type Saved = tokio::sync::OwnedMutexGuard<Option<Snapshot>>;

impl UserState {
    pub(crate) fn directory(&self) -> &std::path::Path {
        self.path.parent().expect("listening state has a directory")
    }

    /// Retains playlist membership, queue entries and history when a host's old path-based
    /// local track is first copied into the server library.
    pub async fn migrate_local_track(self: &std::sync::Arc<Self>, legacy: String, track: Value) -> Result<(), String> {
        fn replace(value: &mut Value, legacy: &str, track: &Value) -> bool {
            if value.get("globalId").and_then(Value::as_str) == Some(legacy) {
                *value = track.clone();
                return true;
            }
            if value.as_str() == Some(legacy) {
                *value = track["globalId"].clone();
                return true;
            }
            let mut changed = false;
            match value {
                Value::Object(fields) => { for child in fields.values_mut() { changed |= replace(child, legacy, track); } }
                Value::Array(items) => { for child in items { changed |= replace(child, legacy, track); } }
                _ => {}
            }
            changed
        }
        for key in ["ambra.playlists.v1", "ambra.queue.v1", "ambra.listening-history.v1", "ambra.library-order.v1", "ambra.removed-library-tracks.v1"] {
            let (legacy, track) = (legacy.clone(), track.clone());
            self.update(key, move |saved| {
                let Some(saved) = saved else { return Ok((None, ())) };
                if !saved.contains(&serde_json::to_string(&legacy).map_err(|e| e.to_string())?) { return Ok((Some(saved.to_owned()), ())) }
                let mut value: Value = serde_json::from_str(saved).map_err(|error| error.to_string())?;
                if replace(&mut value, &legacy, &track) {
                    if key == "ambra.listening-history.v1" {
                        let mut merged: Vec<Value> = Vec::new();
                        for entry in value["entries"].as_array().into_iter().flatten() {
                            if let Some(existing) = merged.iter_mut().find(|existing| existing["track"]["globalId"] == entry["track"]["globalId"]) {
                                existing["playCount"] = json!(existing["playCount"].as_u64().unwrap_or(1) + entry["playCount"].as_u64().unwrap_or(1));
                                existing["lastPlayedAt"] = json!(existing["lastPlayedAt"].as_u64().unwrap_or(0).max(entry["lastPlayedAt"].as_u64().unwrap_or(0)));
                            } else { merged.push(entry.clone()); }
                        }
                        merged.sort_by_key(|entry| std::cmp::Reverse(entry["lastPlayedAt"].as_u64().unwrap_or(0)));
                        value["entries"] = json!(merged);
                    }
                    if key == "ambra.queue.v1" {
                        value["revision"] = json!(value["revision"].as_u64().unwrap_or(0) + 1);
                    }
                    Ok((Some(value.to_string()), ()))
                } else { Ok((Some(saved.to_owned()), ())) }
            }).await?;
        }
        Ok(())
    }

    pub fn new() -> Self {
        Self::at(crate::storage::data_path("user-state.v1.json"))
    }

    pub(crate) fn at(path: PathBuf) -> Self {
        let state = Self {
            path,
            saved: Default::default(),
            revision: watch::channel(0).0,
            patches: Default::default(),
        };
        if let Ok(saved) = state.load() {
            state.revision.send_replace(saved.revision);
            if let Ok(mut slot) = state.saved.try_lock() {
                *slot = Some(saved);
            }
        }
        state
    }

    /// The state in memory, reading the file first if that hasn't succeeded yet. Blocks on
    /// the file the first time, so call it from a blocking worker.
    fn loaded<'a>(&self, slot: &'a mut Option<Snapshot>) -> Result<&'a mut Snapshot, String> {
        if slot.is_none() {
            *slot = Some(self.load()?);
        }
        Ok(slot.as_mut().expect("loaded above"))
    }

    /// Runs `work` on the state with nothing else reading or writing it. `work` may replace
    /// the file, so it runs on a blocking worker.
    async fn with<T: Send + 'static>(
        self: &std::sync::Arc<Self>,
        work: impl FnOnce(&Self, &mut Snapshot) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let mut saved: Saved = self.saved.clone().lock_owned().await;
        let state = self.clone();
        tokio::task::spawn_blocking(move || {
            let snapshot = state.loaded(&mut saved)?;
            work(&state, snapshot)
        })
        .await
        .map_err(|error| error.to_string())?
    }

    /// Reads from the copy in memory, without a worker thread once the file has been read.
    async fn peek<T: Send + 'static>(
        self: &std::sync::Arc<Self>,
        read: impl FnOnce(&Snapshot) -> T + Send + 'static,
    ) -> Result<T, String> {
        {
            let saved = self.saved.lock().await;
            if let Some(snapshot) = saved.as_ref() {
                return Ok(read(snapshot));
            }
        }
        self.with(move |_, snapshot| Ok(read(snapshot))).await
    }

    fn load(&self) -> Result<Snapshot, String> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Snapshot::default());
            }
            Err(error) => return Err(format!("Could not read listening state: {error}")),
        };
        if bytes.len() > MAX_STATE_BYTES {
            return Err("Saved listening state is too large".into());
        }
        let saved: Snapshot = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid saved listening state: {error}"))?;
        for (key, value) in &saved.values {
            validate(key, value)?;
        }
        Ok(saved)
    }

    fn save(&self, saved: &Snapshot) -> Result<(), String> {
        let bytes = serde_json::to_vec(saved).map_err(|error| error.to_string())?;
        if bytes.len() > MAX_STATE_BYTES {
            return Err("Listening state exceeds 64 MiB".into());
        }
        let parent = self
            .path
            .parent()
            .ok_or("Listening state has no directory")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", std::process::id()));
        let result = (|| {
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &self.path)?;
            #[cfg(unix)]
            fs::File::open(parent)?.sync_all()?;
            Ok::<(), std::io::Error>(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(|error| format!("Could not save listening state: {error}"))
    }

    #[cfg(test)]
    pub(crate) fn latest_patch(&self, key: &str) -> Option<Value> {
        self.patches.lock().unwrap().get(key).map(|patch| patch.patch.clone())
    }

    /// Hears every change to the state, the server's own included.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.revision.subscribe()
    }

    /// The current value of `key`.
    pub async fn value(self: &std::sync::Arc<Self>, key: &str) -> Result<Option<String>, String> {
        let key = key.to_owned();
        self.peek(move |saved| saved.values.get(&key).cloned()).await
    }

    /// Atomic recommendation inputs from the same synchronized snapshot.
    pub async fn recommendation_inputs(
        self: &std::sync::Arc<Self>,
    ) -> Result<(Option<String>, Option<String>), String> {
        self.peek(|saved| {
            (
                saved.values.get("ambra.listening-history.v1").cloned(),
                saved.values.get("ambra.playlists.v1").cloned(),
            )
        })
        .await
    }

    /// Changes `key` as the server itself: validated, saved and announced like a client's write.
    /// `change` gets the current value and returns the new one (`None` removes it), or an error
    /// to leave everything as it was.
    pub async fn update<T: Send + 'static>(
        self: &std::sync::Arc<Self>,
        key: &str,
        change: impl FnOnce(Option<&str>) -> Result<(Option<String>, T), String> + Send + 'static,
    ) -> Result<T, String> {
        self.update_patched(key, move |saved| change(saved).map(|(value, result)| (value, None, result))).await
    }

    /// Like `update`, where `change` can also say how an app holding the old value makes the
    /// new one (see `KeyPatch`); apps that ask for patches are sent that instead of the value.
    pub async fn update_patched<T: Send + 'static>(
        self: &std::sync::Arc<Self>,
        key: &str,
        change: impl FnOnce(Option<&str>) -> Result<(Option<String>, Option<Value>, T), String> + Send + 'static,
    ) -> Result<T, String> {
        let key = key.to_owned();
        self.with(move |state, saved| {
            let (value, patch, result) = change(saved.values.get(&key).map(String::as_str))?;
            if saved.values.get(&key) == value.as_ref() {
                return Ok(result);
            }
            if let Some(value) = &value {
                validate(&key, value)?;
            }
            let next = saved.revision.checked_add(1).ok_or("Listening-state revision overflow")?;
            // The copy in memory changes only once the file has: a failed save leaves both as
            // they were.
            let previous = match value {
                Some(value) => saved.values.insert(key.clone(), value),
                None => saved.values.remove(&key),
            };
            let previous_revision = saved.key_revisions.insert(key.clone(), next);
            let (revision, write_id) = (saved.revision, saved.last_write_id.take());
            saved.revision = next;
            if let Err(message) = state.save(saved) {
                match previous {
                    Some(value) => saved.values.insert(key.clone(), value),
                    None => saved.values.remove(&key),
                };
                match previous_revision {
                    Some(changed) => saved.key_revisions.insert(key.clone(), changed),
                    None => saved.key_revisions.remove(&key),
                };
                saved.revision = revision;
                saved.last_write_id = write_id;
                return Err(message);
            }
            let mut patches = state.patches.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match patch {
                Some(patch) => patches.insert(key, KeyPatch { base: previous_revision.unwrap_or(0), revision: next, patch }),
                None => patches.remove(&key),
            };
            drop(patches);
            state.revision.send_replace(next);
            Ok(result)
        })
        .await
    }
}

fn string_list(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn queue_item(value: &Value) -> bool {
    value["globalTrackId"].is_string()
        && (value["shufflePackageId"].is_null() || value["shufflePackageId"].is_string())
        && matches!(
            value["source"]["kind"].as_str(),
            Some("library" | "playlist" | "search")
        )
        && value["source"]["id"].is_string()
        && value["source"]["entryId"]
            .as_f64()
            .is_some_and(f64::is_finite)
}

pub(crate) fn track(value: &Value) -> bool {
    [
        "globalId",
        "providerTrackId",
        "audio",
        "cover",
        "name",
        "album",
        "artist",
    ]
    .iter()
    .all(|key| value[key].is_string())
        && matches!(
            value["provider"].as_str(),
            Some("local" | "tidal" | "qobuz" | "spotify")
        )
        && matches!(value["playbackKind"].as_str(), Some("direct" | "dash"))
        && value["durationSeconds"]
            .as_f64()
            .is_some_and(|seconds| seconds.is_finite() && seconds >= 0.0)
        && ["artists", "albumArtists"].iter().all(|key| {
            value[key].as_array().is_some_and(|artists| {
                artists
                    .iter()
                    .all(|artist| artist["name"].is_string() && artist["providerId"].is_string())
            })
        })
}

fn validate(key: &str, encoded: &str) -> Result<(), String> {
    if !KEYS.contains(&key) {
        return Err(format!("Unsupported listening-state key: {key}"));
    }
    let value: Value = serde_json::from_str(encoded)
        .map_err(|error| format!("Invalid JSON for {key}: {error}"))?;
    let valid = match key {
        "ambra.listening-history.v1" => {
            let mut ids = std::collections::HashSet::new();
            value["version"] == 1
                && value["entries"].as_array().is_some_and(|entries| {
                    entries.iter().all(|entry| {
                        track(&entry["track"])
                            && entry["track"]["globalId"]
                                .as_str()
                                .is_some_and(|id| !id.is_empty() && ids.insert(id))
                            && entry["lastPlayedAt"]
                                .as_u64()
                                .is_some_and(|time| time > 0 && time <= 8_640_000_000_000_000)
                    })
                })
        }
        "ambra.library-order.v1" | "ambra.removed-library-tracks.v1" => string_list(&value),
        key if OPAQUE_KEYS.contains(&key) => value.is_object() || value.is_array(),
        "ambra.playback.v1" => {
            value.is_object()
                && value
                    .get("trackId")
                    .is_some_and(|id| id.is_null() || id.as_str().is_some_and(|id| !id.is_empty()))
                && value["positionSeconds"]
                    .as_f64()
                    .is_some_and(|seconds| seconds.is_finite() && seconds >= 0.0)
        }
        "ambra.queue.v1" => {
            value["version"] == 1
                && value.get("tracks").is_none_or(|tracks| {
                    tracks
                        .as_array()
                        .is_some_and(|items| items.iter().all(track))
                })
                && value
                    .get("current")
                    .is_some_and(|item| item.is_null() || queue_item(item))
                && value["upcoming"]
                    .as_array()
                    .is_some_and(|items| items.iter().all(queue_item))
                && value["history"].as_array().is_some_and(|items| {
                    items.iter().all(|item| {
                        queue_item(item)
                            && item["historyId"].is_string()
                            && item["playedAt"].is_string()
                    })
                })
        }
        "ambra.playlists.v1" => {
            let mut ids = std::collections::HashSet::new();
            value["version"] == 1
                && value["playlists"].as_array().is_some_and(|items| {
                    items.iter().all(|item| {
                        item["id"]
                            .as_str()
                            .is_some_and(|id| !id.is_empty() && ids.insert(id))
                            && item["name"]
                                .as_str()
                                .is_some_and(|name| !name.trim().is_empty())
                            && string_list(&item["trackIds"])
                    })
                })
                && value["tracks"]
                    .as_array()
                    .is_some_and(|items| items.iter().all(track))
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("Invalid listening state for {key}"))
    }
}

fn error(status: StatusCode, message: impl ToString) -> Response {
    (status, Json(json!({ "error": message.to_string() }))).into_response()
}

pub fn router<S: Clone + Send + Sync + 'static>(state: std::sync::Arc<UserState>) -> Router<S> {
    Router::new()
        .route("/api/state", get(read).post(write))
        .layer(DefaultBodyLimit::max(MAX_STATE_BYTES))
        .with_state(state)
}

#[derive(Deserialize)]
struct ReadQuery {
    /// Only what changed after this revision.
    since: Option<u64>,
    /// With `since`, wait up to this many seconds for a change before answering.
    wait: Option<u64>,
    /// Keys (comma-separated) the app follows another way and doesn't want here: the queue,
    /// which changes with every song and which apps following the session already have.
    /// Changes to them alone neither end the wait nor come back in `changes`.
    without: Option<String>,
    /// Set by apps that take a key's change as a patch to the value they have (`patches` in
    /// the answer) where the server has one, in place of the whole value in `changes`.
    patches: Option<u8>,
}

async fn read(State(state): State<std::sync::Arc<UserState>>, Query(query): Query<ReadQuery>) -> Response {
    let without: Changes = query.without.as_deref().unwrap_or_default().split(',').filter(|key| !key.is_empty()).map(|key| (key.to_owned(), None)).collect();
    if let (Some(since), Some(wait)) = (query.since, query.wait.filter(|wait| *wait > 0)) {
        let mut revision = state.revision.subscribe();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(wait.min(MAX_WAIT_SECONDS));
        let mut seen = since;
        loop {
            let Ok(Ok(current)) = tokio::time::timeout_at(deadline, revision.wait_for(|current| *current != seen)).await.map(|changed| changed.map(|current| *current)) else { break };
            seen = current;
            if without.is_empty() { break; }
            // Only the keys this app left out changed: it keeps waiting for one it follows.
            let wanted = { let without = without.clone(); state.peek(move |saved| since > saved.revision || saved.key_revisions.iter().any(|(key, changed)| *changed > since && !without.contains_key(key))).await };
            if wanted.unwrap_or(true) { break; }
        }
    }
    // Only what the answer holds is copied, and nothing is read from disk.
    let patched = if query.patches.is_some_and(|patches| patches > 0) {
        state.patches.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    } else {
        BTreeMap::new()
    };
    let answer = state
        .peek(move |saved| match query.since {
            Some(since) if since <= saved.revision => {
                // A key whose only change since the app's revision is one the server can
                // describe travels as that description.
                let mut except = without;
                let mut patches = serde_json::Map::new();
                for (key, patch) in patched {
                    if patch.base <= since && since < patch.revision && saved.key_revisions.get(&key) == Some(&patch.revision) && !except.contains_key(&key) {
                        except.insert(key.clone(), None);
                        patches.insert(key, patch.patch);
                    }
                }
                let mut body = json!({ "revision": saved.revision, "changes": saved.changes_since(since, &except) });
                if !patches.is_empty() { body["patches"] = Value::Object(patches); }
                Ok(body)
            }
            // A revision the server never reached means its state was replaced; start over.
            Some(_) => Err(()),
            None => Ok(json!({ "revision": saved.revision, "values": saved.values })),
        })
        .await;
    match answer {
        Ok(Ok(body)) => ([(CACHE_CONTROL, "no-store")], Json(body)).into_response(),
        Ok(Err(())) => error(StatusCode::CONFLICT, "The server's listening state was replaced; reload it."),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

async fn write(
    State(state): State<std::sync::Arc<UserState>>,
    Json(patch): Json<Patch>,
) -> Response {
    if patch.write_id.is_empty() || patch.write_id.len() > 128 {
        return error(
            StatusCode::BAD_REQUEST,
            "A listening-state write requires an ID of at most 128 bytes",
        );
    }
    for (key, value) in &patch.changes {
        if !KEYS.contains(&key.as_str()) {
            return error(StatusCode::BAD_REQUEST, "Unsupported listening-state key");
        }
        if let Some(value) = value {
            if let Err(message) = validate(key, value) {
                return error(StatusCode::BAD_REQUEST, message);
            }
        }
    }
    let outcome = state
        .with(move |state, saved| Ok(apply(state, saved, patch)))
        .await;
    match outcome {
        // What other clients changed since this one's revision comes back with the receipt.
        Ok(Ok(receipt)) => ([(CACHE_CONTROL, "no-store")], Json(receipt)).into_response(),
        Ok(Err(Refused::Conflict(keys, changes, revision))) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Another device changed this since it was loaded.",
                "keys": keys, "revision": revision, "changes": changes,
            })),
        )
            .into_response(),
        Ok(Err(Refused::Replaced)) => error(StatusCode::CONFLICT, "The server's listening state was replaced; reload it."),
        Ok(Err(Refused::Status(status, message))) => error(status, message),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

/// Applies a client's write to the state, replacing the file before the copy in memory.
/// Returns the receipt: the new revision and what other clients changed meanwhile.
fn apply(state: &UserState, saved: &mut Snapshot, patch: Patch) -> Result<Value, Refused> {
    let receipt = |saved: &Snapshot| json!({ "revision": saved.revision, "changes": saved.changes_since(patch.revision, &patch.changes) });
    let identical = patch
        .changes
        .iter()
        .all(|(key, value)| saved.values.get(key) == value.as_ref());
    // A lost HTTP acknowledgement can be retried without writing twice.
    if saved.last_write_id.as_deref() == Some(&patch.write_id) {
        return if identical {
            Ok(receipt(saved))
        } else {
            Err(Refused::Status(StatusCode::BAD_REQUEST, "Write ID was reused for a different change".into()))
        };
    }
    if patch.revision > saved.revision {
        return Err(Refused::Replaced);
    }
    let conflicts = patch
        .changes
        .keys()
        .filter(|key| saved.changed_since(key, patch.bases.get(*key).copied().unwrap_or(patch.revision).min(patch.revision)))
        .cloned()
        .collect::<Vec<_>>();
    if !conflicts.is_empty() {
        // Everything since the oldest edit, so the writer can adopt what it missed.
        let oldest = patch.bases.values().copied().chain([patch.revision]).min().unwrap_or(patch.revision);
        let changes = saved.changes_since(oldest, &Changes::new());
        return Err(Refused::Conflict(conflicts, changes, saved.revision));
    }
    // Revision zero is uninitialized. Even an empty migration claims it,
    // preventing another device's old local state from being imported later.
    if identical && saved.revision != 0 {
        return Ok(receipt(saved));
    }
    if saved.revision != 0 && patch.changes.contains_key("ambra.queue.v1") {
        return Err(Refused::Status(StatusCode::BAD_REQUEST, "Change the queue through /api/session/queue".into()));
    }
    let next_revision = saved.revision.checked_add(1).ok_or_else(|| {
        Refused::Status(StatusCode::INTERNAL_SERVER_ERROR, "Listening-state revision overflow".into())
    })?;
    // Built beside the current state and swapped in only once the file has been replaced,
    // so a failed save leaves memory and disk agreeing.
    let mut next = saved.clone();
    for (key, value) in patch.changes.clone() {
        next.key_revisions.insert(key.clone(), next_revision);
        match value {
            Some(value) => {
                next.values.insert(key, value);
            }
            None => {
                next.values.remove(&key);
            }
        }
    }
    next.revision = next_revision;
    next.last_write_id = Some(patch.write_id.clone());
    state
        .save(&next)
        .map_err(|message| Refused::Status(StatusCode::INTERNAL_SERVER_ERROR, message))?;
    *saved = next;
    state.revision.send_replace(next_revision);
    Ok(receipt(saved))
}

enum Refused {
    /// These keys changed on another client after the writer's revision; the writer gets
    /// everything that changed meanwhile so it can catch up.
    Conflict(Vec<String>, Changes, u64),
    /// The writer saw a revision this server never reached.
    Replaced,
    Status(StatusCode, String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn state() -> Arc<UserState> {
        let path = std::env::temp_dir().join(format!("ambra-user-state-{}-{}.json", std::process::id(), crate::server_config::random_hex(6)));
        Arc::new(UserState::at(path))
    }

    async fn body(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn save(state: &Arc<UserState>, revision: u64, key: &str, value: Value) -> (StatusCode, Value) {
        let patch = Patch {
            revision,
            write_id: crate::server_config::random_hex(8),
            changes: BTreeMap::from([(key.to_owned(), Some(value.to_string()))]),
            bases: BTreeMap::new(),
        };
        body(write(State(state.clone()), Json(patch)).await).await
    }

    async fn since(state: &Arc<UserState>, revision: u64) -> Value {
        body(read(State(state.clone()), Query(ReadQuery { since: Some(revision), wait: None, without: None, patches: None })).await).await.1
    }

    const PLAYBACK: &str = "ambra.playback.v1";
    const ORDER: &str = "ambra.library-order.v1";

    #[tokio::test]
    async fn clients_editing_different_keys_never_conflict() {
        let state = state();
        let (status, first) = save(&state, 0, ORDER, json!(["a"])).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(first["revision"], 1);
        // Both clients loaded revision 1. A saves playback; B, still on 1, saves the order.
        assert_eq!(save(&state, 1, PLAYBACK, json!({ "trackId": "x", "positionSeconds": 3 })).await.0, StatusCode::OK);
        let (status, receipt) = save(&state, 1, ORDER, json!(["a", "b"])).await;
        assert_eq!(status, StatusCode::OK);
        // B learns of A's playback change from its receipt.
        assert_eq!(receipt["revision"], 3);
        assert!(receipt["changes"][PLAYBACK].as_str().unwrap().contains("\"x\""));
        assert!(receipt["changes"].get(ORDER).is_none());
    }

    #[tokio::test]
    async fn overwriting_another_clients_newer_change_is_refused_with_the_news() {
        let state = state();
        save(&state, 0, ORDER, json!(["a"])).await;
        save(&state, 1, ORDER, json!(["a", "b"])).await;
        let (status, refused) = save(&state, 1, ORDER, json!(["stale"])).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(refused["keys"], json!([ORDER]));
        assert_eq!(refused["revision"], 2);
        assert_eq!(refused["changes"][ORDER], json!(["a", "b"]).to_string());
    }

    #[tokio::test]
    async fn readers_get_only_what_changed_and_wait_for_news() {
        let state = state();
        save(&state, 0, ORDER, json!(["a"])).await;
        save(&state, 1, PLAYBACK, json!({ "trackId": null, "positionSeconds": 0 })).await;
        let news = since(&state, 1).await;
        assert_eq!(news["revision"], 2);
        assert_eq!(news["changes"].as_object().unwrap().keys().collect::<Vec<_>>(), vec![PLAYBACK]);
        assert_eq!(since(&state, 2).await["changes"], json!({}));

        let waiting = tokio::spawn({
            let state = state.clone();
            async move { body(read(State(state), Query(ReadQuery { since: Some(2), wait: Some(5), without: None, patches: None })).await).await.1 }
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        save(&state, 2, ORDER, json!(["b"])).await;
        let woken = tokio::time::timeout(std::time::Duration::from_secs(2), waiting).await.unwrap().unwrap();
        assert_eq!(woken["revision"], 3);
        assert_eq!(woken["changes"][ORDER], json!(["b"]).to_string());
    }

    #[tokio::test]
    async fn a_key_conflicts_from_where_its_edit_began_not_the_latest_news() {
        let state = state();
        save(&state, 0, ORDER, json!(["a"])).await;
        // Another device changes the order at revision 2; this one heard of it (revision 2)
        // while it was already editing the order from revision 1.
        save(&state, 1, ORDER, json!(["other"])).await;
        let patch = Patch {
            revision: 2,
            write_id: "w".into(),
            changes: BTreeMap::from([(ORDER.to_owned(), Some(json!(["mine"]).to_string()))]),
            bases: BTreeMap::from([(ORDER.to_owned(), 1)]),
        };
        let (status, refused) = body(write(State(state.clone()), Json(patch)).await).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(refused["keys"], json!([ORDER]));
        // It gets the version it missed, though it was already on revision 2.
        assert_eq!(refused["changes"][ORDER], json!(["other"]).to_string());
    }

    #[tokio::test]
    async fn a_revision_the_server_never_reached_means_start_over() {
        let state = state();
        save(&state, 0, ORDER, json!(["a"])).await;
        assert_eq!(save(&state, 9, ORDER, json!(["b"])).await.0, StatusCode::CONFLICT);
        let response = read(State(state.clone()), Query(ReadQuery { since: Some(9), wait: None, without: None, patches: None })).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn importing_a_windows_file_retains_playlist_membership_and_queue_history() {
        let state = state();
        let legacy = r"local:C:\Users\Listener\Music\Ambra\song.flac";
        let old = json!({ "globalId": legacy, "providerTrackId": "old.flac", "audio": "asset://old.flac", "cover": "", "name": "Song", "album": "Album", "artist": "Artist", "provider": "local", "playbackKind": "direct", "durationSeconds": 20, "artists": [], "albumArtists": [] });
        let mut imported = old.clone();
        imported["globalId"] = json!("local:content-hash");
        imported["audio"] = json!("/api/music/local/files/content-hash.flac");
        state.update("ambra.playlists.v1", {
            let old = old.clone();
            move |_| Ok((Some(json!({ "version": 1, "playlists": [{ "id": "mix", "name": "Mix", "trackIds": [legacy], "packages": [] }], "tracks": [old] }).to_string()), ()))
        }).await.unwrap();
        state.update("ambra.library-order.v1", move |_| Ok((Some(json!([legacy]).to_string()), ()))).await.unwrap();
        state.update("ambra.queue.v1", {
            let old = old.clone();
            move |_| Ok((Some(json!({ "version": 1, "revision": 4, "current": { "globalTrackId": legacy, "source": { "kind": "library", "id": "library", "entryId": 1 }, "shufflePackageId": null }, "upcoming": [], "history": [], "tracks": [old] }).to_string()), ()))
        }).await.unwrap();
        state.update("ambra.listening-history.v1", move |_| Ok((Some(json!({ "version": 1, "entries": [{ "track": old, "lastPlayedAt": 1, "playCount": 2 }] }).to_string()), ()))).await.unwrap();
        state.migrate_local_track(legacy.into(), imported.clone()).await.unwrap();
        let playlists: Value = serde_json::from_str(&state.value("ambra.playlists.v1").await.unwrap().unwrap()).unwrap();
        assert_eq!(playlists["playlists"][0]["trackIds"][0], imported["globalId"]);
        assert_eq!(playlists["tracks"][0], imported);
        assert_eq!(state.value("ambra.library-order.v1").await.unwrap().unwrap(), json!(["local:content-hash"]).to_string());
        let queue: Value = serde_json::from_str(&state.value("ambra.queue.v1").await.unwrap().unwrap()).unwrap();
        assert_eq!(queue["current"]["globalTrackId"], imported["globalId"]);
        assert_eq!(queue["revision"], 5);
        // Repeated imports do not rewrite the state or count a play.
        let revision = *state.revision.borrow();
        state.migrate_local_track(legacy.into(), imported).await.unwrap();
        assert_eq!(*state.revision.borrow(), revision);
        let history: Value = serde_json::from_str(&state.value("ambra.listening-history.v1").await.unwrap().unwrap()).unwrap();
        assert_eq!(history["entries"][0]["playCount"], 2);
        assert_eq!(history["entries"][0]["track"]["globalId"], "local:content-hash");
    }

    #[tokio::test]
    async fn every_acknowledged_write_is_on_disk_for_the_next_start() {
        let state = state();
        save(&state, 0, ORDER, json!(["a"])).await;
        state.update(PLAYBACK, |_| Ok((Some(json!({ "trackId": "x", "positionSeconds": 1 }).to_string()), ()))).await.unwrap();
        // An unchanged value writes nothing and keeps the revision.
        state.update(PLAYBACK, |saved| Ok((saved.map(str::to_owned), ()))).await.unwrap();
        assert_eq!(*state.revision.borrow(), 2);
        // A change that fails validation leaves the state as it was, in memory and on disk.
        assert!(state.update(PLAYBACK, |_| Ok((Some("[]".into()), ()))).await.is_err());
        assert!(state.update(ORDER, |_| Err::<(Option<String>, ()), _>("refused".into())).await.is_err());
        assert_eq!(*state.revision.borrow(), 2);

        let restarted = Arc::new(UserState::at(state.path.clone()));
        assert_eq!(*restarted.revision.borrow(), 2);
        assert_eq!(restarted.value(ORDER).await.unwrap().unwrap(), json!(["a"]).to_string());
        assert!(restarted.value(PLAYBACK).await.unwrap().unwrap().contains("\"x\""));
        // What the running server answers is what the file holds.
        let on_disk: Snapshot = serde_json::from_slice(&fs::read(&state.path).unwrap()).unwrap();
        assert_eq!(on_disk.values, since(&state, 0).await["changes"].as_object().unwrap().iter().map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned())).collect());
    }

    #[tokio::test]
    async fn an_unreadable_file_is_reported_and_never_replaced() {
        let state = state();
        fs::write(&state.path, b"not json").unwrap();
        let state = Arc::new(UserState::at(state.path.clone()));
        assert!(state.value(ORDER).await.is_err());
        assert_eq!(save(&state, 0, ORDER, json!(["a"])).await.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(fs::read(&state.path).unwrap(), b"not json");
        // Repaired by hand, it is read on the next request.
        fs::remove_file(&state.path).unwrap();
        assert_eq!(save(&state, 0, ORDER, json!(["a"])).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn keys_an_app_leaves_out_neither_wake_it_nor_reach_it() {
        let state = state();
        save(&state, 0, ORDER, json!(["a"])).await;
        let waiting = tokio::spawn({
            let state = state.clone();
            async move { body(read(State(state), Query(ReadQuery { since: Some(1), wait: Some(5), without: Some(format!("{PLAYBACK},ambra.queue.v1")), patches: None })).await).await.1 }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // A key it left out changes twice: it goes on waiting.
        for position in [1, 2] {
            state.update(PLAYBACK, move |_| Ok((Some(json!({ "trackId": "x", "positionSeconds": position }).to_string()), ()))).await.unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(!waiting.is_finished());
        // A key it follows changes: it hears of that one alone, at the newest revision.
        save(&state, 3, ORDER, json!(["b"])).await;
        let woken = tokio::time::timeout(std::time::Duration::from_secs(2), waiting).await.unwrap().unwrap();
        assert_eq!(woken["revision"], 4);
        assert_eq!(woken["changes"], json!({ ORDER: json!(["b"]).to_string() }));
        // With nothing it follows changed, the wait ends on time with no changes.
        state.update(PLAYBACK, |_| Ok((Some(json!({ "trackId": "y", "positionSeconds": 0 }).to_string()), ()))).await.unwrap();
        let quiet = body(read(State(state.clone()), Query(ReadQuery { since: Some(4), wait: Some(1), without: Some(PLAYBACK.into()), patches: None })).await).await.1;
        assert_eq!(quiet, json!({ "revision": 5, "changes": {} }));
    }

    #[tokio::test]
    async fn a_change_the_server_can_describe_reaches_apps_that_ask_as_a_patch() {
        let state = state();
        let read = |since: u64, patches: Option<u8>| { let state = state.clone(); async move {
            body(read(State(state), Query(ReadQuery { since: Some(since), wait: None, without: None, patches })).await).await.1
        } };
        save(&state, 0, ORDER, json!(["a"])).await;
        state.update_patched(ORDER, |_| Ok((Some(json!(["b", "a"]).to_string()), Some(json!({ "unshift": "b" })), ()))).await.unwrap();
        // An app with the value before it gets the patch; one that didn't ask, the value.
        assert_eq!(read(1, Some(1)).await, json!({ "revision": 2, "changes": {}, "patches": { ORDER: { "unshift": "b" } } }));
        assert_eq!(read(1, None).await, json!({ "revision": 2, "changes": { ORDER: json!(["b", "a"]).to_string() } }));
        // Other keys changing since doesn't stop it; the app has the patched key's old value.
        save(&state, 2, PLAYBACK, json!({ "trackId": null, "positionSeconds": 0 })).await;
        let news = read(1, Some(1)).await;
        assert_eq!(news["patches"], json!({ ORDER: { "unshift": "b" } }));
        assert_eq!(news["changes"].as_object().unwrap().keys().collect::<Vec<_>>(), vec![PLAYBACK]);
        // An app from before the key's previous change missed more than the patch covers.
        assert_eq!(read(0, Some(1)).await["changes"][ORDER], json!(["b", "a"]).to_string());
        assert!(read(0, Some(1)).await.get("patches").is_none());
        // A change without a description, or by a client, travels whole again.
        state.update(ORDER, |_| Ok((Some(json!(["c"]).to_string()), ()))).await.unwrap();
        let whole = read(3, Some(1)).await;
        assert!(whole.get("patches").is_none());
        assert_eq!(whole["changes"][ORDER], json!(["c"]).to_string());
        state.update_patched(ORDER, |_| Ok((Some(json!(["d", "c"]).to_string()), Some(json!({ "unshift": "d" })), ()))).await.unwrap();
        save(&state, 5, ORDER, json!(["client"])).await;
        let whole = read(4, Some(1)).await;
        assert!(whole.get("patches").is_none());
        assert_eq!(whole["changes"][ORDER], json!(["client"]).to_string());
    }

    #[tokio::test]
    async fn queue_writes_after_initial_migration_belong_to_the_core() {
        let state = state();
        let queue = json!({ "version": 1, "current": null, "upcoming": [], "history": [], "tracks": [] });
        assert_eq!(save(&state, 0, "ambra.queue.v1", queue.clone()).await.0, StatusCode::OK);
        let mut changed = queue;
        changed["revision"] = json!(10);
        assert_eq!(save(&state, 1, "ambra.queue.v1", changed).await.0, StatusCode::BAD_REQUEST);
    }
}
