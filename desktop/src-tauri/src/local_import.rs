//! Copies scanned local music and its artwork into the selected server's permanent library.
use std::{collections::{BTreeMap, BTreeSet}, fs::File, io::{Read, Seek}, path::{Path, PathBuf}, time::{Duration, UNIX_EPOCH}};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::blocking::{Client, RequestBuilder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::server_link::{Connection, Mode, ServerLink};

fn authorize(request: RequestBuilder, connection: &Connection) -> RequestBuilder {
    match &connection.token {
        Some(token) if !connection.fallback => request.bearer_auth(token),
        _ => request,
    }
}

fn check(response: reqwest::blocking::Response) -> Result<reqwest::blocking::Response, String> {
    if response.status().is_success() { return Ok(response) }
    let status = response.status();
    let body = response.text().unwrap_or_default();
    Err(format!("Could not import music ({status}): {body}"))
}

#[derive(Serialize, Deserialize)]
struct CachedFile { length: u64, modified: u128, id: String }

fn upload_file(client: &Client, connection: &Connection, path: &Path, cache: &mut BTreeMap<String, CachedFile>) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let stamp = file.metadata().map_err(|e| e.to_string())?;
    let modified = stamp.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |time| time.as_nanos());
    let key = path.to_string_lossy().into_owned();
    // Scanning a large library on launch must not reread every audio file just to hash it.
    let cached = cache.get(&key).filter(|cached| modified > 0 && cached.length == stamp.len() && cached.modified == modified);
    let id = if let Some(cached) = cached { cached.id.clone() } else {
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 128 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 { break }
            hash.update(&buffer[..read]);
        }
        let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("bin").to_ascii_lowercase();
        let extension = if !extension.is_empty() && extension.len() <= 8 && extension.bytes().all(|b| b.is_ascii_alphanumeric()) { extension } else { "bin".into() };
        format!("{:x}.{extension}", hash.finalize())
    };
    let url = format!("{}/api/music/local/files/{id}", connection.base_url);
    let exists = authorize(client.head(&url), connection).send().map_err(|e| e.to_string())?;
    if exists.status().is_success() {
        cache.insert(key, CachedFile { length: stamp.len(), modified, id: id.clone() });
        return Ok(id);
    }
    if exists.status() != reqwest::StatusCode::NOT_FOUND { check(exists)?; }
    file.rewind().map_err(|e| e.to_string())?;
    check(authorize(client.post(url), connection).body(file).send().map_err(|e| e.to_string())?)?;
    cache.insert(key, CachedFile { length: stamp.len(), modified, id: id.clone() });
    Ok(id)
}

fn upload_artwork(client: &Client, connection: &Connection, source: &str, cache: &mut BTreeMap<String, CachedFile>) -> Result<String, String> {
    if !source.starts_with("data:") { return upload_file(client, connection, Path::new(source), cache) }
    let (kind, encoded) = source.split_once(',').ok_or("Invalid embedded artwork")?;
    let bytes = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
    let extension = if kind.contains("image/png") { "png" } else if kind.contains("image/webp") { "webp" } else { "jpg" };
    let id = format!("{:x}.{extension}", Sha256::digest(&bytes));
    check(authorize(client.post(format!("{}/api/music/local/files/{id}", connection.base_url)), connection).body(bytes).send().map_err(|e| e.to_string())?)?;
    Ok(id)
}

fn metadata(track: &crate::Track, file: &str, artwork: Option<&str>, migrate: bool) -> Value {
    let artists = json!([{ "providerId": track.artist, "name": track.artist, "imageUrl": null }]);
    json!({
        "file": file, "artwork": artwork,
        "legacyId": migrate.then(|| format!("local:{}", track.audio)),
        "name": track.name, "artist": track.artist, "album": track.album,
        "trackNumber": track.track_number, "durationSeconds": track.duration_seconds,
        "artists": artists, "albumArtists": artists,
        "version": null, "albumVersion": null, "albumId": null, "discNumber": null,
        "releaseDate": null, "explicit": false, "isrc": null, "copyright": null,
        "label": null, "genres": [], "upc": null, "quality": null,
        "maximumSamplingRateKHz": null, "maximumBitDepth": null,
    })
}

/// Copies scanned tracks, checking a shared cover once per import.
fn upload_tracks(
    app: &tauri::AppHandle,
    connection: &Connection,
    tracks: impl IntoIterator<Item = crate::Track>,
    full_list: bool,
) -> Result<Vec<Value>, String> {
    let client = Client::builder().timeout(Duration::from_secs(30 * 60)).build().map_err(|e| e.to_string())?;
    let cache_path = crate::cache_directory(app)?.join("server-imports.v1.json");
    let mut cache: BTreeMap<String, CachedFile> = std::fs::read(&cache_path).ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    let mut covers = BTreeMap::new();
    let mut imported = BTreeMap::new();
    for track in tracks {
        let file = upload_file(&client, connection, Path::new(&track.audio), &mut cache)?;
        let artwork = match track.cover {
            Some(ref cover) => Some(match covers.entry(cover.clone()) {
                std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(upload_artwork(&client, connection, cover, &mut cache)?)
                }
            }.as_str()),
            None => None,
        };
        let details = metadata(&track, &file, artwork, connection.mode == Mode::Host || connection.fallback);
        let response = check(authorize(client.post(format!("{}/api/music/local/tracks", connection.base_url)), connection)
            .json(&details).send().map_err(|e| e.to_string())?)?;
        if !full_list {
            let track: Value = response.json().map_err(|e| e.to_string())?;
            let id = track["globalId"].as_str().ok_or("Server returned a track without an ID")?;
            imported.insert(id.to_owned(), track);
        }
    }
    crate::write_file_atomic(&cache_path, &serde_json::to_vec(&cache).map_err(|e| e.to_string())?)?;
    if !full_list {
        return Ok(imported.into_values().collect());
    }
    check(authorize(client.get(format!("{}/api/music/local/tracks", connection.base_url)), connection)
        .send().map_err(|e| e.to_string())?)?.json().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_local_music(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let connection = app.state::<ServerLink>().connection();
    tauri::async_runtime::spawn_blocking(move || {
        let tracks = crate::scan_music_blocking(&app)?;
        upload_tracks(&app, &connection, tracks, true)
    }).await.map_err(|e| e.to_string())?
}

/// Whether two files hold the same bytes, so dropping a song twice keeps one copy.
fn same_contents(left: &Path, right: &Path) -> Result<bool, String> {
    let (mut left, mut right) = (File::open(left).map_err(|e| e.to_string())?, File::open(right).map_err(|e| e.to_string())?);
    if left.metadata().map_err(|e| e.to_string())?.len() != right.metadata().map_err(|e| e.to_string())?.len() { return Ok(false) }
    let (mut a, mut b) = (vec![0_u8; 128 * 1024], vec![0_u8; 128 * 1024]);
    loop {
        let read = left.read(&mut a).map_err(|e| e.to_string())?;
        if read == 0 { return Ok(true) }
        right.read_exact(&mut b[..read]).map_err(|e| e.to_string())?;
        if a[..read] != b[..read] { return Ok(false) }
    }
}

/// Copies one dropped file into the music folder and returns where it now lives. A file
/// already there, or an identical copy of it, is not copied again.
fn copy_into_library(source: &Path, library: &Path, canonical_library: &Path) -> Result<PathBuf, String> {
    let canonical = source.canonicalize().map_err(|e| format!("Could not read {}: {e}", source.display()))?;
    // Spelled the way the scanner spells it, so the scanned track can be matched.
    if let Ok(inside) = canonical.strip_prefix(canonical_library) { return Ok(library.join(inside)) }
    let stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("Track").to_owned();
    let extension = source.extension().and_then(|s| s.to_str()).unwrap_or_default().to_owned();
    for copy in 1.. {
        let name = if copy == 1 { format!("{stem}.{extension}") } else { format!("{stem} ({copy}).{extension}") };
        let destination = library.join(name);
        if destination.exists() {
            if same_contents(&source, &destination)? { return Ok(destination) }
            continue;
        }
        // The scanner skips the partial name, so a concurrent scan never indexes half a file.
        let partial = destination.with_extension("partial");
        std::fs::copy(&source, &partial).map_err(|e| format!("Could not copy {}: {e}", source.display()))?;
        std::fs::rename(&partial, &destination).map_err(|e| {
            let _ = std::fs::remove_file(&partial);
            format!("Could not add {}: {e}", source.display())
        })?;
        return Ok(destination);
    }
    unreachable!()
}

#[derive(Serialize)]
pub struct DroppedMusic {
    /// This device's whole local library after the import.
    tracks: Vec<crate::Track>,
    /// How many dropped songs are now in the library.
    imported: usize,
    /// The tracks copied to the server, when upload was requested.
    server: Option<Vec<Value>>,
}

/// Adds audio files (or folders of them) dropped on the window to the music folder, and
/// to the server's library too when `upload` is set.
#[tauri::command]
pub async fn import_dropped_music(app: tauri::AppHandle, paths: Vec<String>, upload: bool) -> Result<DroppedMusic, String> {
    let connection = app.state::<ServerLink>().connection();
    tauri::async_runtime::spawn_blocking(move || {
        let library = crate::local_music_directory(&app)?;
        let canonical_library = library.canonicalize().map_err(|e| e.to_string())?;
        let mut added = BTreeSet::new();
        for path in paths {
            for entry in walkdir::WalkDir::new(&path).follow_links(false).into_iter().filter_map(Result::ok) {
                if entry.file_type().is_file() && crate::is_supported_audio(entry.path()) {
                    added.insert(copy_into_library(entry.path(), &library, &canonical_library)?.to_string_lossy().into_owned());
                }
            }
        }
        let entries = crate::scan_music_entries(&app)?;
        let imported: Vec<_> = entries.iter().filter(|entry| added.contains(&entry.path)).map(|entry| entry.track.clone()).collect();
        let server = if upload && !imported.is_empty() { Some(upload_tracks(&app, &connection, imported.iter().cloned(), false)?) } else { None };
        Ok(DroppedMusic { imported: imported.len(), tracks: entries.into_iter().map(|entry| entry.track).collect(), server })
    }).await.map_err(|e| e.to_string())?
}
