//! Server-owned listening state. A revision protects the entire snapshot from
//! stale clients; disk replacement completes before a write is acknowledged.

use std::{collections::BTreeMap, fs, io::Write, path::PathBuf};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

const MAX_STATE_BYTES: usize = 64 * 1024 * 1024;
const KEYS: &[&str] = &[
    "ambra.playlists.v1",
    "ambra.queue.v1",
    "ambra.playback.v1",
    "ambra.listening-history.v1",
    "ambra.library-order.v1",
    "ambra.removed-library-tracks.v1",
];

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    revision: u64,
    values: BTreeMap<String, String>,
    #[serde(default, rename = "lastWriteId")]
    last_write_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Patch {
    revision: u64,
    #[serde(rename = "writeId")]
    write_id: String,
    changes: BTreeMap<String, Option<String>>,
}

pub struct UserState {
    path: PathBuf,
    lock: Mutex<()>,
}

impl UserState {
    pub fn new() -> Self {
        Self {
            path: crate::storage::data_path("user-state.v1.json"),
            lock: Mutex::new(()),
        }
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

fn track(value: &Value) -> bool {
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

async fn read(State(state): State<std::sync::Arc<UserState>>) -> Response {
    let _guard = state.lock.lock().await;
    let state = state.clone();
    match tokio::task::spawn_blocking(move || state.load()).await {
        Ok(Ok(saved)) => ([(CACHE_CONTROL, "no-store")], Json(saved)).into_response(),
        Ok(Err(message)) => error(StatusCode::INTERNAL_SERVER_ERROR, message),
        Err(error_message) => error(StatusCode::INTERNAL_SERVER_ERROR, error_message),
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
    let _guard = state.lock.lock().await;
    let state = state.clone();
    match tokio::task::spawn_blocking(move || {
        let mut saved = state
            .load()
            .map_err(|message| (StatusCode::INTERNAL_SERVER_ERROR, message))?;
        let identical = patch
            .changes
            .iter()
            .all(|(key, value)| saved.values.get(key) == value.as_ref());
        // A lost HTTP acknowledgement can be retried without writing twice.
        if saved.last_write_id.as_deref() == Some(&patch.write_id) {
            return if identical {
                Ok(saved)
            } else {
                Err((
                    StatusCode::BAD_REQUEST,
                    "Write ID was reused for a different change".into(),
                ))
            };
        }
        if saved.revision != patch.revision {
            return Err((
                StatusCode::CONFLICT,
                "Listening state changed on another client. Reload server state before saving."
                    .into(),
            ));
        }
        // Revision zero is uninitialized. Even an empty migration claims it,
        // preventing another device's old local state from being imported later.
        if identical && saved.revision != 0 {
            return Ok(saved);
        }
        for (key, value) in patch.changes {
            match value {
                Some(value) => {
                    saved.values.insert(key, value);
                }
                None => {
                    saved.values.remove(&key);
                }
            }
        }
        saved.revision = saved.revision.checked_add(1).ok_or((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Listening-state revision overflow".into(),
        ))?;
        saved.last_write_id = Some(patch.write_id);
        state
            .save(&saved)
            .map_err(|message| (StatusCode::INTERNAL_SERVER_ERROR, message))?;
        Ok::<_, (StatusCode, String)>(saved)
    })
    .await
    {
        Ok(Ok(saved)) => (
            [(CACHE_CONTROL, "no-store")],
            Json(json!({ "revision": saved.revision })),
        )
            .into_response(),
        Ok(Err((status, message))) => error(status, message),
        Err(error_message) => error(StatusCode::INTERNAL_SERVER_ERROR, error_message),
    }
}
