//! Durable desktop state, stored as one small file per key plus a revision file.
//!
//! The previous layout was a single JSON blob holding every key (including the
//! whole streaming-library cache). Every save rewrote all of it, and every
//! launch had to read and ship all of it to the WebView. With one file per key:
//!
//! * a launch whose WebView storage is already current reads only the revision
//!   file (a few bytes) and transfers nothing;
//! * a save touches only the keys that changed, so a playback-position update
//!   writes a few hundred bytes instead of megabytes;
//! * the legacy `desktop-state.json` is migrated transparently on first save.

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

pub const PERSISTENT_STATE_KEYS: [&str; 7] = [
    "ambra.preferences",
    "ambra.current-screen",
    "ambra.playlists.v1",
    "ambra.streaming-library.v1",
    "ambra.removed-library-tracks.v1",
    "ambra.library-order.v1",
    "ambra.queue.v1",
];
const MAX_VALUE_BYTES: usize = 64 * 1024 * 1024;
const STATE_DIRECTORY: &str = "desktop-state";
const REVISION_FILE: &str = "revision";
const LEGACY_FILE: &str = "desktop-state.json";

static WRITE_LOCK: Mutex<()> = Mutex::new(());
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyState {
    version: u8,
    updated_at_ms: u64,
    values: BTreeMap<String, String>,
}

/// `values` is present only when the stored state is newer than the revision the
/// caller already has, so an up-to-date WebView receives a tiny response.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedState {
    pub updated_at_ms: u64,
    pub values: Option<BTreeMap<String, String>>,
}

/// Changed keys only. `None` deletes the key.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePatch {
    pub updated_at_ms: u64,
    pub changes: BTreeMap<String, Option<String>>,
}

fn state_directory(data_dir: &Path) -> PathBuf {
    data_dir.join(STATE_DIRECTORY)
}

fn key_path(directory: &Path, key: &str) -> PathBuf {
    directory.join(format!("{key}.json"))
}

fn check_key(key: &str) -> Result<(), String> {
    if PERSISTENT_STATE_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(format!(
            "The desktop tried to save an unsupported key: {key}"
        ))
    }
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    }
}

fn read_revision(directory: &Path) -> Result<Option<u64>, String> {
    Ok(read_optional(&directory.join(REVISION_FILE))?
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| text.trim().parse().ok()))
}

fn read_legacy(data_dir: &Path) -> Result<Option<LegacyState>, String> {
    let path = data_dir.join(LEGACY_FILE);
    let Some(encoded) = read_optional(&path)? else {
        return Ok(None);
    };
    if encoded.len() > MAX_VALUE_BYTES {
        return Err("Ambra's saved desktop state is unexpectedly large".to_owned());
    }
    let state: LegacyState = serde_json::from_slice(&encoded)
        .map_err(|error| format!("Could not decode {}: {error}", path.display()))?;
    if state.version != 1 || state.values.keys().any(|key| check_key(key).is_err()) {
        return Err("Ambra's saved desktop state has an unsupported format".to_owned());
    }
    Ok(Some(state))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary_id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary_path =
        path.with_extension(format!("{}.{}.tmp", std::process::id(), temporary_id));
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary_path)
        .map_err(|error| format!("Could not create {}: {error}", temporary_path.display()))?;
    file.write_all(bytes)
        .map_err(|error| format!("Could not write {}: {error}", temporary_path.display()))?;
    file.sync_all()
        .map_err(|error| format!("Could not sync {}: {error}", temporary_path.display()))?;
    drop(file);
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| {
            let _ = fs::remove_file(&temporary_path);
            format!("Could not replace {}: {error}", path.display())
        })?;
    }
    fs::rename(&temporary_path, path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        format!("Could not replace {}: {error}", path.display())
    })
}

pub fn load(
    data_dir: &Path,
    known_updated_at_ms: Option<u64>,
) -> Result<Option<LoadedState>, String> {
    let directory = state_directory(data_dir);
    if let Some(revision) = read_revision(&directory)? {
        if known_updated_at_ms.is_some_and(|known| known >= revision) {
            return Ok(Some(LoadedState {
                updated_at_ms: revision,
                values: None,
            }));
        }
        let mut values = BTreeMap::new();
        for key in PERSISTENT_STATE_KEYS {
            if let Some(bytes) = read_optional(&key_path(&directory, key))? {
                let value = String::from_utf8(bytes)
                    .map_err(|_| format!("Saved value for {key} is not valid UTF-8"))?;
                values.insert(key.to_owned(), value);
            }
        }
        return Ok(Some(LoadedState {
            updated_at_ms: revision,
            values: Some(values),
        }));
    }

    Ok(read_legacy(data_dir)?.map(|legacy| {
        let current = known_updated_at_ms.is_some_and(|known| known >= legacy.updated_at_ms);
        LoadedState {
            updated_at_ms: legacy.updated_at_ms,
            values: (!current).then_some(legacy.values),
        }
    }))
}

pub fn save(data_dir: &Path, patch: StatePatch) -> Result<(), String> {
    for (key, value) in &patch.changes {
        check_key(key)?;
        if value
            .as_ref()
            .is_some_and(|value| value.len() > MAX_VALUE_BYTES)
        {
            return Err("Ambra's saved desktop state is too large".to_owned());
        }
    }

    let _guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let directory = state_directory(data_dir);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create {}: {error}", directory.display()))?;

    // Seed the per-key layout from the legacy blob so a partial patch can never
    // make the keys it does not mention disappear.
    if read_revision(&directory)?.is_none() {
        if let Some(legacy) = read_legacy(data_dir)? {
            for (key, value) in &legacy.values {
                write_atomic(&key_path(&directory, key), value.as_bytes())?;
            }
        }
    }

    for (key, value) in &patch.changes {
        let path = key_path(&directory, key);
        match value {
            Some(value) => write_atomic(&path, value.as_bytes())?,
            None => match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("Could not remove {}: {error}", path.display()));
                }
            },
        }
    }
    write_atomic(
        &directory.join(REVISION_FILE),
        patch.updated_at_ms.to_string().as_bytes(),
    )
}
