//! Copies scanned local music and its artwork into the selected server's permanent library.
use std::{collections::BTreeMap, fs::File, io::{Read, Seek}, path::Path, time::{Duration, UNIX_EPOCH}};

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

#[tauri::command]
pub async fn import_local_music(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let connection = app.state::<ServerLink>().connection();
    tauri::async_runtime::spawn_blocking(move || {
        let tracks = crate::scan_music_blocking(&app)?;
        let client = Client::builder().timeout(Duration::from_secs(30 * 60)).build().map_err(|e| e.to_string())?;
        let cache_path = crate::cache_directory(&app)?.join("server-imports.v1.json");
        let mut cache: BTreeMap<String, CachedFile> = std::fs::read(&cache_path).ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        for track in tracks {
            let file = upload_file(&client, &connection, Path::new(&track.audio), &mut cache)?;
            let artwork = track.cover.as_deref().map(|cover| upload_artwork(&client, &connection, cover, &mut cache)).transpose()?;
            let details = metadata(&track, &file, artwork.as_deref(), connection.mode == Mode::Host || connection.fallback);
            check(authorize(client.post(format!("{}/api/music/local/tracks", connection.base_url)), &connection)
                .json(&details).send().map_err(|e| e.to_string())?)?;
        }
        crate::write_file_atomic(&cache_path, &serde_json::to_vec(&cache).map_err(|e| e.to_string())?)?;
        check(authorize(client.get(format!("{}/api/music/local/tracks", connection.base_url)), &connection)
            .send().map_err(|e| e.to_string())?)?.json().map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}
