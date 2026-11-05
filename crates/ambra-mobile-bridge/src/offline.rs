//! Songs downloaded to this phone, so they play without the server.
//!
//! A download is fetched from the paired server (`/api/downloads/source/…`) through the
//! connection manager and encrypted with this installation's own key as it arrives
//! (`ambra-vault`). The player can't read encrypted files, so a loopback server on a random
//! port and secret path decrypts them as they're played, with byte ranges for seeking. It
//! needs no server connection, so downloads keep playing offline.

use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Mutex},
};

use ambra_net::ConnectionManager;
use ambra_vault::{Entry, Quality, Store, file_stem, now_seconds};
use axum::{
    Router,
    body::Body,
    extract::{Path as UrlPath, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use bytes::Bytes;
use http_body_util::BodyExt;
use serde::Serialize;
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, String>;

const STREAM_PIECE: usize = 256 * 1024;

pub struct Offline {
    store: Arc<Store>,
    base_url: String,
    jobs: Mutex<HashMap<String, Job>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// `running`, `done` or `failed`.
    state: &'static str,
    error: Option<String>,
}

static OFFLINE: Mutex<Option<Arc<Offline>>> = Mutex::new(None);

#[derive(Clone)]
struct Served {
    store: Arc<Store>,
    capability: String,
}

/// Opens the store and its loopback player server once; later calls reuse them.
pub async fn open(directory: &str) -> Result<Arc<Offline>> {
    if let Some(offline) = OFFLINE.lock().map_err(|_| "Offline lock failed")?.clone() {
        return Ok(offline);
    }
    let root = Path::new(directory);
    // The key lives apart from the downloads, so copying that folder doesn't copy it.
    let store = Arc::new(
        Store::open(root.join("downloads"), &root.join("vault").join("download-vault.key"))
            .map_err(|error| format!("Downloads are unavailable: {error}"))?,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let mut secret = [0_u8; 24];
    getrandom::fill(&mut secret).map_err(|error| error.to_string())?;
    let capability = secret.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let app = Router::new()
        .route("/{capability}/{file}", get(serve))
        .with_state(Served { store: store.clone(), capability: capability.clone() });
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let offline = Arc::new(Offline { store, base_url: format!("http://{address}/{capability}"), jobs: Mutex::new(HashMap::new()) });
    let mut slot = OFFLINE.lock().map_err(|_| "Offline lock failed")?;
    // Another call may have opened it meanwhile; keep the first.
    Ok(slot.get_or_insert(offline).clone())
}

impl Offline {
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn url(&self, file: &str) -> String {
        format!("{}/{}", self.base_url, urlencoding::encode(file))
    }

    /// Every downloaded song, with the URLs that play it and show its cover.
    pub fn list(&self) -> Value {
        Value::Array(
            self.store
                .entries()
                .into_iter()
                .map(|entry| {
                    let url = self.url(&entry.file);
                    let cover = entry.cover_file.as_deref().map(|file| self.url(file));
                    let mut value = serde_json::to_value(&entry).unwrap_or(Value::Null);
                    value["url"] = json!(url);
                    value["coverUrl"] = json!(cover);
                    value
                })
                .collect(),
        )
    }

    pub fn remove(&self, ids: &[String]) -> Result<()> {
        for id in ids {
            self.store.remove(id).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn jobs(&self) -> Value {
        serde_json::to_value(self.jobs.lock().map(|jobs| jobs.clone()).unwrap_or_default()).unwrap_or(Value::Null)
    }

    /// Starts downloading in the background; `jobs` reports how it went, by song ID.
    pub fn start(self: &Arc<Self>, manager: Arc<ConnectionManager>, provider: String, track_id: String, quality: Quality) -> Result<String> {
        if !matches!(provider.as_str(), "tidal" | "qobuz" | "spotify") {
            return Err("Only streaming songs can be downloaded".into());
        }
        if track_id.is_empty() || track_id.len() > 128 || !track_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
            return Err("Invalid track ID".into());
        }
        let id = format!("{provider}:{track_id}");
        {
            let mut jobs = self.jobs.lock().map_err(|_| "Offline lock failed")?;
            if jobs.get(&id).is_some_and(|job| job.state == "running") {
                return Ok(id);
            }
            jobs.insert(id.clone(), Job { state: "running", error: None });
        }
        let offline = self.clone();
        let key = id.clone();
        tokio::spawn(async move {
            let result = download(&manager, &offline.store, &provider, &track_id, quality).await;
            if let Ok(mut jobs) = offline.jobs.lock() {
                jobs.insert(key, match result {
                    Ok(()) => Job { state: "done", error: None },
                    Err(error) => Job { state: "failed", error: Some(error) },
                });
            }
        });
        Ok(id)
    }
}

async fn send(manager: &ConnectionManager, path: &str) -> Result<hyper::Response<hyper::body::Incoming>> {
    let request = hyper::Request::builder()
        .method(hyper::Method::GET)
        .uri(path)
        .body(Body::empty())
        .map_err(|error| error.to_string())?;
    let response = manager.request(request).await.map_err(|error| error.to_string())?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.into_body().collect().await.map(|body| body.to_bytes()).unwrap_or_default();
    let message = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|value| value["error"].as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("The server answered {status}"));
    Err(message)
}

async fn get_bytes(manager: &ConnectionManager, path: &str) -> Result<Bytes> {
    let response = send(manager, path).await?;
    response.into_body().collect().await.map(|body| body.to_bytes()).map_err(|error| error.to_string())
}

fn header_text(headers: &hyper::HeaderMap, name: &str) -> Option<String> {
    headers.get(name)?.to_str().ok().map(str::to_owned)
}

async fn download(manager: &ConnectionManager, store: &Store, provider: &str, track_id: &str, quality: Quality) -> Result<()> {
    let id = format!("{provider}:{track_id}");
    if store.get(&id).is_some_and(|entry| entry.requested_quality == quality) {
        return Ok(());
    }
    let metadata: Value = serde_json::from_slice(&get_bytes(manager, &format!("/api/providers/{provider}/tracks/{track_id}/metadata")).await?)
        .map_err(|error| error.to_string())?;

    let response = send(manager, &format!("/api/downloads/source/{provider}/{track_id}?quality={}", quality.as_str())).await?;
    let headers = response.headers().clone();
    let container = header_text(&headers, "x-ambra-container")
        .filter(|container| matches!(container.as_str(), "flac" | "m4a" | "mp3" | "ogg"))
        .unwrap_or_else(|| "flac".into());
    let mime_type = header_text(&headers, "content-type").unwrap_or_else(|| "audio/flac".into());
    let quality_label = header_text(&headers, "x-ambra-quality")
        .and_then(|label| urlencoding::decode(&label).ok().map(|label| label.into_owned()))
        .unwrap_or_else(|| "Downloaded".into());
    let sample_rate_khz = header_text(&headers, "x-ambra-sample-rate-khz").and_then(|value| value.parse().ok());
    let bit_depth = header_text(&headers, "x-ambra-bit-depth").and_then(|value| value.parse().ok());
    let expected = header_text(&headers, "content-length").and_then(|value| value.parse::<u64>().ok());

    let stem = file_stem(&id);
    let file = format!("{stem}.{container}");
    let mut pending = store.begin(&file).map_err(|error| error.to_string())?;
    let mut body = response.into_body();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|error| error.to_string())?;
        if let Ok(data) = frame.into_data() {
            pending.writer().write_all(&data).map_err(|error| error.to_string())?;
        }
    }
    if expected.is_some_and(|expected| expected != pending.writer().len()) {
        return Err("The download was cut short".into());
    }
    let size = store.finish(pending).map_err(|error| error.to_string())?;

    // The cover comes through the server's small thumbnail, so no other host is contacted.
    let cover_file = match metadata["album"]["coverUrl"].as_str() {
        Some(url) if url.starts_with("https://") || url.starts_with('/') => {
            let path = if url.starts_with('/') {
                url.to_owned()
            } else {
                format!("/api/artwork/thumbnail?provider={provider}&url={}", urlencoding::encode(url))
            };
            match get_bytes(manager, &path).await {
                Ok(bytes) if !bytes.is_empty() => {
                    let cover = format!("{stem}.jpg");
                    store.write_small(&cover, &bytes).ok().map(|()| cover)
                }
                _ => None,
            }
        }
        _ => None,
    };

    store
        .record(Entry {
            id,
            provider: provider.to_owned(),
            provider_track_id: track_id.to_owned(),
            file,
            container,
            mime_type,
            requested_quality: quality,
            quality_label,
            sample_rate_khz,
            bit_depth,
            size_bytes: size,
            downloaded_at: now_seconds(),
            metadata,
            cover_file,
        })
        .map_err(|error| error.to_string())
}

fn content_type(file: &str) -> &'static str {
    match file.rsplit('.').next() {
        Some("flac") => "audio/flac",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("jpg") => "image/jpeg",
        _ => "application/octet-stream",
    }
}

/// `start`, `end` (inclusive) and whether it's a partial answer.
fn byte_range(headers: &HeaderMap, total: u64) -> Option<(u64, u64, bool)> {
    let Some(value) = headers.get(header::RANGE) else {
        return Some((0, total.saturating_sub(1), false));
    };
    let range = value.to_str().ok()?.strip_prefix("bytes=")?;
    if range.contains(',') || total == 0 {
        return None;
    }
    let (start, end) = range.split_once('-')?;
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().ok().filter(|suffix| *suffix > 0)?;
        (total.saturating_sub(suffix), total - 1)
    } else {
        let start = start.parse::<u64>().ok().filter(|start| *start < total)?;
        let end = if end.is_empty() { total - 1 } else { end.parse::<u64>().ok()?.min(total - 1) };
        (start, end)
    };
    (end >= start).then_some((start, end, true))
}

async fn serve(State(served): State<Served>, UrlPath((capability, file)): UrlPath<(String, String)>, headers: HeaderMap) -> Response {
    if capability != served.capability || file.contains(['/', '\\']) || file.starts_with('.') {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(reader) = served.store.open_file(&file) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let total = reader.len();
    let Some((start, end, partial)) = byte_range(&headers, total) else {
        let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
        if let Ok(value) = HeaderValue::from_str(&format!("bytes */{total}")) {
            response.headers_mut().insert(header::CONTENT_RANGE, value);
        }
        return response;
    };
    let length = if total == 0 { 0 } else { end - start + 1 };
    let (sender, receiver) = tokio::sync::mpsc::channel::<std::io::Result<Bytes>>(4);
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let result = (|| -> std::io::Result<()> {
            reader.seek(SeekFrom::Start(start))?;
            let mut remaining = length;
            let mut buffer = vec![0; STREAM_PIECE];
            while remaining > 0 {
                let read = reader.read(&mut buffer[..(remaining as usize).min(STREAM_PIECE)])?;
                if read == 0 {
                    break;
                }
                remaining -= read as u64;
                if sender.blocking_send(Ok(Bytes::copy_from_slice(&buffer[..read]))).is_err() {
                    break;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = sender.blocking_send(Err(error));
        }
    });
    let stream = futures_stream(receiver);
    let mut response = Response::builder()
        .status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, content_type(&file))
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    if partial && let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")) {
        response.headers_mut().insert(header::CONTENT_RANGE, value);
    }
    response
}

/// The channel as a stream.
fn futures_stream(
    mut receiver: tokio::sync::mpsc::Receiver<std::io::Result<Bytes>>,
) -> impl futures_util::Stream<Item = std::io::Result<Bytes>> + Send {
    futures_util::stream::poll_fn(move |context| receiver.poll_recv(context))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn fetch(url: &str, range: Option<&str>) -> (String, Vec<u8>) {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut stream = tokio::net::TcpStream::connect(host).await.unwrap();
        let range = range.map(|range| format!("Range: {range}\r\n")).unwrap_or_default();
        stream.write_all(format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\n{range}Connection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let split = response.windows(4).position(|window| window == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&response[..split]).into_owned(), response[split + 4..].to_vec())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn downloads_play_decrypted_in_ranges_without_a_server() {
        let root = std::env::temp_dir().join(format!("ambra-mobile-offline-{}", std::process::id()));
        let offline = open(root.to_str().unwrap()).await.unwrap();
        let audio = (0..300_000_u32).map(|index| (index % 251) as u8).collect::<Vec<_>>();
        let mut pending = offline.store.begin("tidal-1.flac").unwrap();
        pending.writer().write_all(&audio).unwrap();
        offline.store.finish(pending).unwrap();
        offline.store.record(Entry {
            id: "tidal:1".into(), provider: "tidal".into(), provider_track_id: "1".into(), file: "tidal-1.flac".into(),
            container: "flac".into(), mime_type: "audio/flac".into(), requested_quality: Quality::Max, quality_label: "FLAC".into(),
            sample_rate_khz: None, bit_depth: None, size_bytes: audio.len() as u64, downloaded_at: 0, metadata: Value::Null, cover_file: None,
        }).unwrap();
        // Nothing on disk is playable as it is.
        assert!(!std::fs::read(offline.store.path("tidal-1.flac")).unwrap().windows(16).any(|window| window == &audio[1000..1016]));

        let list = offline.list();
        let url = list[0]["url"].as_str().unwrap().to_owned();
        let (head, body) = fetch(&url, Some("bytes=100000-100099")).await;
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.to_ascii_lowercase().contains("content-range: bytes 100000-100099/300000"), "{head}");
        assert_eq!(body, &audio[100_000..100_100]);
        let (head, body) = fetch(&url, None).await;
        assert!(head.starts_with("HTTP/1.1 200"));
        assert_eq!(body.len(), audio.len());

        // A wrong secret or a path outside the store finds nothing.
        let (head, _) = fetch(&url.replace(offline.base_url(), &format!("{}x", offline.base_url())), None).await;
        assert!(head.starts_with("HTTP/1.1 404"), "{head}");

        offline.remove(&["tidal:1".into()]).unwrap();
        assert_eq!(offline.list(), json!([]));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ranges_are_parsed_like_a_media_server() {
        let mut headers = HeaderMap::new();
        assert_eq!(byte_range(&headers, 10), Some((0, 9, false)));
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=-4"));
        assert_eq!(byte_range(&headers, 10), Some((6, 9, true)));
        headers.insert(header::RANGE, HeaderValue::from_static("bytes=12-"));
        assert_eq!(byte_range(&headers, 10), None);
    }
}
