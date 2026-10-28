//! Imported music belongs to the server, independently of the importing app.
//! Files are content-addressed, streamed to disk, verified, and published atomically.
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt}, sync::Mutex};
use tokio_util::io::ReaderStream;

const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

struct Library {
    root: PathBuf,
    lock: Mutex<()>,
    state: Arc<crate::user_state::UserState>,
}

pub fn router<S: Clone + Send + Sync + 'static>(state: Arc<crate::user_state::UserState>) -> Router<S> {
    routes(Arc::new(Library { root: crate::storage::data_path("local-music"), lock: Mutex::new(()), state }))
}

fn routes<S: Clone + Send + Sync + 'static>(library: Arc<Library>) -> Router<S> {
    Router::new()
        .route("/api/music/local/tracks", get(list).post(add))
        .route("/api/music/local/files/{id}", get(download).post(upload))
        .route("/api/music/local/files/{id}/palette", get(artwork_palette))
        .layer(DefaultBodyLimit::disable())
        .with_state(library)
}

fn valid_id(id: &str) -> bool {
    let Some((hash, extension)) = id.split_once('.') else { return false };
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && !extension.is_empty() && extension.len() <= 8 && extension.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn error(status: StatusCode, message: impl ToString) -> Response {
    (status, Json(json!({ "error": message.to_string() }))).into_response()
}

async fn artwork_palette(State(library): State<Arc<Library>>, Path(id): Path<String>) -> Response {
    if !valid_id(&id) {
        return error(StatusCode::BAD_REQUEST, "Invalid artwork file ID");
    }
    let file = match tokio::fs::File::open(library.root.join(id)).await {
        Ok(file) => file,
        Err(_) => return error(StatusCode::NOT_FOUND, "Artwork not found"),
    };
    // Bound image work independently of the much larger audio upload limit.
    const MAX_ARTWORK_BYTES: u64 = 16 * 1024 * 1024;
    let mut bytes = Vec::new();
    if file.take(MAX_ARTWORK_BYTES + 1).read_to_end(&mut bytes).await.is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Could not read artwork");
    }
    if bytes.len() as u64 > MAX_ARTWORK_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Artwork is too large");
    }
    match tokio::task::spawn_blocking(move || crate::artwork_quality::dominant_palette(&bytes)).await {
        Ok(Some(palette)) => ([(header::CACHE_CONTROL, "private, max-age=604800")], Json(palette)).into_response(),
        _ => error(StatusCode::BAD_REQUEST, "Could not measure artwork colors"),
    }
}

async fn read_index(library: &Library) -> Result<BTreeMap<String, Value>, String> {
    match tokio::fs::read(library.root.join("library.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error.to_string()),
    }
}

async fn list(State(library): State<Arc<Library>>) -> Response {
    let _guard = library.lock.lock().await;
    match read_index(&library).await {
        Ok(index) => ([(header::CACHE_CONTROL, "no-store")], Json(index.into_values().collect::<Vec<_>>())).into_response(),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

async fn add(State(library): State<Arc<Library>>, request: Request) -> Response {
    let bytes = match axum::body::to_bytes(request.into_body(), 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::BAD_REQUEST, "Track metadata exceeds 1 MB"),
    };
    let mut track: Value = match serde_json::from_slice(&bytes) {
        Ok(Value::Object(object)) => Value::Object(object),
        _ => return error(StatusCode::BAD_REQUEST, "Invalid track metadata"),
    };
    let Some(file) = track["file"].as_str().filter(|id| valid_id(id)).map(str::to_owned) else {
        return error(StatusCode::BAD_REQUEST, "Invalid music file ID");
    };
    if !tokio::fs::try_exists(library.root.join(&file)).await.unwrap_or(false) {
        return error(StatusCode::BAD_REQUEST, "Upload the music file first");
    }
    if !track["name"].is_string() || !track["artist"].is_string() || !track["album"].is_string()
        || !track["durationSeconds"].as_f64().is_some_and(|duration| duration.is_finite() && duration >= 0.0)
    {
        return error(StatusCode::BAD_REQUEST, "A track needs a title, artist, album and duration");
    }
    let artwork = track["artwork"].as_str().filter(|id| valid_id(id)).map(str::to_owned);
    if let Some(artwork) = &artwork {
        if !tokio::fs::try_exists(library.root.join(artwork)).await.unwrap_or(false) {
            return error(StatusCode::BAD_REQUEST, "Upload the artwork first");
        }
    }
    let legacy = track["legacyId"].as_str().filter(|id| id.starts_with("local:")).map(str::to_owned);
    let id = format!("local:{}", file.split('.').next().unwrap());
    track["globalId"] = json!(id);
    track["provider"] = json!("local");
    track["providerTrackId"] = json!(file);
    track["playbackKind"] = json!("direct");
    track["audio"] = json!(format!("/api/music/local/files/{file}"));
    let cover = artwork.map(|id| format!("/api/music/local/files/{id}"));
    track["cover"] = json!(cover.as_deref().unwrap_or("/white.svg"));
    track["fullCover"] = track["cover"].clone();
    track["nativeCover"] = json!(cover);
    for key in ["file", "artwork", "legacyId"] { track.as_object_mut().unwrap().remove(key); }
    if !crate::user_state::track(&track) {
        return error(StatusCode::BAD_REQUEST, "Invalid track metadata");
    }
    let _guard = library.lock.lock().await;
    let mut index = match read_index(&library).await {
        Ok(index) => index,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, message),
    };
    if index.get(&id) != Some(&track) {
        index.insert(id, track.clone());
        let path = library.root.join("library.json");
        let saved = tokio::task::spawn_blocking(move || {
            crate::server_config::write_private(&path, &serde_json::to_vec(&index).map_err(|e| e.to_string())?)
        }).await;
        if !matches!(saved, Ok(Ok(()))) {
            return error(StatusCode::INTERNAL_SERVER_ERROR, "Could not save the local library");
        }
    }
    if let Some(legacy) = legacy {
        if let Err(message) = library.state.migrate_local_track(legacy, track.clone()).await {
            return error(StatusCode::INTERNAL_SERVER_ERROR, message);
        }
    }
    Json(track).into_response()
}

async fn upload(State(library): State<Arc<Library>>, Path(id): Path<String>, request: Request) -> Response {
    if !valid_id(&id) { return error(StatusCode::BAD_REQUEST, "Invalid file ID") }
    let path = library.root.join(&id);
    if let Err(message) = tokio::fs::create_dir_all(&library.root).await {
        return error(StatusCode::INTERNAL_SERVER_ERROR, message);
    }
    let temporary = library.root.join(format!("import-{}.tmp", crate::server_config::random_hex(12)));
    let saved = async {
        let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).await.map_err(|e| e.to_string())?;
        let mut stream = request.into_body().into_data_stream();
        let mut hash = Sha256::new();
        let mut length = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            length += chunk.len() as u64;
            if length > MAX_FILE_BYTES { return Err("Music files may be at most 8 GB".into()) }
            hash.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
        if length == 0 || format!("{:x}", hash.finalize()) != id[..64] {
            return Err("The uploaded file does not match its content ID".into());
        }
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
        // A concurrent import of the same content is equivalent.
        if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
            if let Err(error) = tokio::fs::rename(&temporary, &path).await {
                if !tokio::fs::try_exists(&path).await.unwrap_or(false) { return Err(error.to_string()) }
            }
        }
        Ok::<_, String>(())
    }.await;
    let _ = tokio::fs::remove_file(&temporary).await;
    match saved {
        Ok(()) => Json(json!({})).into_response(),
        Err(message) => error(StatusCode::BAD_REQUEST, message),
    }
}

fn byte_range(value: &str, length: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if length == 0 { return None }
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(length);
        return (suffix > 0).then_some((length - suffix, length - 1));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() { length - 1 } else { end.parse::<u64>().ok()?.min(length - 1) };
    (start <= end && start < length).then_some((start, end))
}

async fn download(State(library): State<Arc<Library>>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    if !valid_id(&id) { return error(StatusCode::BAD_REQUEST, "Invalid file ID") }
    let mut file = match tokio::fs::File::open(library.root.join(&id)).await {
        Ok(file) => file,
        Err(_) => return error(StatusCode::NOT_FOUND, "The server does not have this file"),
    };
    let length = match file.metadata().await { Ok(metadata) => metadata.len(), Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, e) };
    let requested = headers.get(header::RANGE);
    let range = requested.and_then(|value| value.to_str().ok()).and_then(|value| byte_range(value, length));
    if requested.is_some() && range.is_none() {
        return (StatusCode::RANGE_NOT_SATISFIABLE, [(header::CONTENT_RANGE, format!("bytes */{length}"))]).into_response();
    }
    let (start, end) = range.unwrap_or((0, length.saturating_sub(1)));
    let count = if length == 0 { 0 } else { end - start + 1 };
    if let Err(e) = file.seek(std::io::SeekFrom::Start(start)).await { return error(StatusCode::INTERNAL_SERVER_ERROR, e) }
    let content_type = match id.rsplit('.').next().unwrap_or_default() {
        "flac" => "audio/flac", "mp3" => "audio/mpeg", "m4a" | "mp4" => "audio/mp4", "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg", "jpg" | "jpeg" => "image/jpeg", "png" => "image/png", "webp" => "image/webp",
        _ => "application/octet-stream",
    };
    let mut response = Body::from_stream(ReaderStream::new(file.take(count))).into_response();
    let sent = response.headers_mut();
    sent.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    sent.insert(header::CONTENT_LENGTH, count.into());
    sent.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    sent.insert(header::CACHE_CONTROL, "private, max-age=31536000, immutable".parse().unwrap());
    if range.is_some() {
        sent.insert(header::CONTENT_RANGE, format!("bytes {start}-{end}/{length}").parse().unwrap());
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn harness(root: PathBuf) -> (String, tokio::task::JoinHandle<()>) {
        let state = Arc::new(crate::user_state::UserState::at(root.join("state.json")));
        let mut config = crate::server_config::ServerConfig::load_default_for_tests();
        config.paired_clients.push(crate::server_config::PairedClient {
            id: "test-device".into(), name: "Laptop".into(),
            token_sha256: crate::server_config::token_hash("test-token"), paired_at_ms: 1, public_key: None,
        });
        let policy = crate::access::AccessPolicy::from_env(crate::network::Network::new(config));
        // With no ConnectInfo these requests take the paired-device path, even on loopback.
        let app: Router = routes(Arc::new(Library { root, state, lock: Mutex::new(()) }))
            .layer(axum::middleware::from_fn_with_state(policy, crate::access::enforce))
            .layer(axum::Extension(ambra_net::transport::RemotePeer { public_key: ambra_net::Identity::generate().unwrap().public_key(), address: "192.0.2.2:1".parse().unwrap(), session: std::sync::Arc::new(ambra_net::transport::Session::default()) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, task)
    }

    fn directory() -> PathBuf {
        std::env::temp_dir().join(format!("ambra-local-music-{}-{}", std::process::id(), crate::server_config::random_hex(8)))
    }

    fn paired_client() -> reqwest::Client {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer test-token".parse().unwrap());
        reqwest::Client::builder().default_headers(headers).build().unwrap()
    }

    #[tokio::test]
    async fn imported_music_survives_the_uploader_and_server_restart_and_supports_seeking() {
        let root = directory();
        let (base, server) = harness(root.clone()).await;
        let client = paired_client();
        let audio: Vec<u8> = (0..=255).cycle().take(200_000).collect();
        let id = format!("{:x}.flac", Sha256::digest(&audio));
        let file_url = format!("{base}/api/music/local/files/{id}");
        assert_eq!(client.post(&file_url).body(audio.clone()).send().await.unwrap().status(), StatusCode::OK);
        assert_eq!(client.head(&file_url).send().await.unwrap().status(), StatusCode::OK);
        let metadata = json!({ "file": id, "name": "Song", "artist": "Artist", "album": "Album", "durationSeconds": 30, "artists": [], "albumArtists": [] });
        let track: Value = client.post(format!("{base}/api/music/local/tracks")).json(&metadata).send().await.unwrap().json().await.unwrap();
        assert!(track["globalId"].as_str().unwrap().starts_with("local:"));
        assert_eq!(track["audio"], format!("/api/music/local/files/{id}"));
        assert_eq!(track["provider"], "local");
        // Importing the same file again leaves one library entry.
        assert_eq!(client.post(format!("{base}/api/music/local/tracks")).json(&metadata).send().await.unwrap().status(), StatusCode::OK);
        server.abort();
        drop(client);

        let (base, server) = harness(root.clone()).await;
        let other_device = paired_client();
        let tracks: Vec<Value> = other_device.get(format!("{base}/api/music/local/tracks")).send().await.unwrap().json().await.unwrap();
        assert_eq!(tracks, vec![track]);
        let url = format!("{base}/api/music/local/files/{id}");
        let response = other_device.get(&url).send().await.unwrap();
        assert_eq!(response.bytes().await.unwrap().as_ref(), audio.as_slice());
        for (range, start, end) in [("bytes=123-456", 123, 456), ("bytes=199900-", 199900, 199999), ("bytes=-17", 199983, 199999)] {
            let response = other_device.get(&url).header(header::RANGE, range).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.headers()[header::CONTENT_RANGE], format!("bytes {start}-{end}/200000"));
            assert_eq!(response.bytes().await.unwrap().as_ref(), &audio[start..=end]);
        }
        let response = other_device.get(&url).header(header::RANGE, "bytes=200000-").send().await.unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */200000");
        let unpaired = reqwest::Client::new();
        assert_eq!(unpaired.get(&url).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
        assert_eq!(unpaired.get(format!("{url}?access_token=test-token")).send().await.unwrap().status(), StatusCode::OK);
        server.abort();
        // Keep test artifacts in the OS temporary directory; no user library is touched.
    }

    #[tokio::test]
    async fn artwork_palettes_follow_the_imported_cover_and_require_pairing() {
        let (base, server) = harness(directory()).await;
        let client = paired_client();
        let mut images = Vec::new();
        for color in [[220, 30, 20], [20, 30, 220]] {
            let image = image::RgbImage::from_pixel(8, 8, image::Rgb(color));
            let mut encoded = std::io::Cursor::new(Vec::new());
            image.write_to(&mut encoded, image::ImageFormat::Png).unwrap();
            let bytes = encoded.into_inner();
            let id = format!("{:x}.png", Sha256::digest(&bytes));
            let url = format!("{base}/api/music/local/files/{id}");
            assert_eq!(client.post(&url).body(bytes).send().await.unwrap().status(), StatusCode::OK);
            let palette: crate::artwork_quality::ArtworkPalette = client.get(format!("{url}/palette")).send().await.unwrap().json().await.unwrap();
            assert_eq!(palette.colors.len(), 4);
            assert_eq!(palette.weights.len(), 4);
            images.push(palette);
            assert_eq!(reqwest::get(format!("{url}/palette")).await.unwrap().status(), StatusCode::UNAUTHORIZED);
        }
        assert_ne!(images[0].colors, images[1].colors);
        let missing = format!("{base}/api/music/local/files/{}.png/palette", "0".repeat(64));
        assert_eq!(client.get(missing).send().await.unwrap().status(), StatusCode::NOT_FOUND);
        server.abort();
    }

    #[tokio::test]
    async fn a_failed_or_mismatched_upload_never_enters_the_library() {
        let root = directory();
        let (base, server) = harness(root.clone()).await;
        let client = paired_client();
        let id = format!("{}.flac", "0".repeat(64));
        let url = format!("{base}/api/music/local/files/{id}");
        assert_eq!(client.post(&url).body("wrong content").send().await.unwrap().status(), StatusCode::BAD_REQUEST);
        assert_eq!(client.get(&url).send().await.unwrap().status(), StatusCode::NOT_FOUND);
        let metadata = json!({ "file": id, "name": "Song", "artist": "Artist", "album": "Album", "durationSeconds": 30 });
        assert_eq!(client.post(format!("{base}/api/music/local/tracks")).json(&metadata).send().await.unwrap().status(), StatusCode::BAD_REQUEST);
        let entries: Vec<Value> = client.get(format!("{base}/api/music/local/tracks")).send().await.unwrap().json().await.unwrap();
        assert!(entries.is_empty());
        assert!(!valid_id("../credentials.json"));
        assert!(!valid_id(&format!("{}.flac/anything", "a".repeat(64))));
        server.abort();
    }
}
