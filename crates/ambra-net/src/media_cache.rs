//! Read-ahead for audio played through the bridge.
//!
//! A phone that walks out of Wi-Fi range loses its LAN connection mid-song, and the next
//! path can take seconds to establish. Players read media through the bridge, so the bridge
//! downloads each song to disk as fast as the connection allows and serves the player from
//! that copy. When the connection drops, the download resumes with a byte range on whichever
//! connection comes next while the player keeps reading what is already on disk. The next
//! song in the queue is downloaded the same way before it starts.

use crate::{ConnectionManager, Result};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::Request;
use std::{
    collections::HashMap,
    io::SeekFrom,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::{Notify, Semaphore, watch},
    task::JoinHandle,
};

/// Songs kept on disk: the one playing, the next one, and the previous one for a quick back.
const MAX_GROUPS: usize = 3;
/// Downloads started ahead of the player share this many connections' worth of bandwidth.
const BACKGROUND_DOWNLOADS: usize = 2;
/// A body that delivers nothing for this long is treated as a dead connection.
const STALL: Duration = Duration::from_secs(8);
/// Seeking further than this past the downloaded part asks the server for that range directly.
const FAR_SEEK: u64 = 4 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

#[derive(Clone, Debug, Default)]
struct Progress {
    /// Contiguous bytes on disk, from the start.
    downloaded: u64,
    total: Option<u64>,
    content_type: Option<HeaderValue>,
    done: bool,
    /// A refusal that retrying cannot fix, such as a missing song.
    failed: Option<(StatusCode, String)>,
}

struct Entry {
    file: PathBuf,
    progress: watch::Sender<Progress>,
    /// Lets a download waiting for a background slot start at once when the player needs it.
    urgent: Arc<Notify>,
    task: Mutex<Option<JoinHandle<()>>>,
}
impl Drop for Entry {
    fn drop(&mut self) {
        if let Some(task) = self.task.lock().ok().and_then(|mut task| task.take()) {
            task.abort();
        }
        // An open reader keeps the data until it finishes, on every platform this runs on.
        let _ = std::fs::remove_file(&self.file);
    }
}

#[derive(Default)]
struct Group {
    entries: HashMap<String, Arc<Entry>>,
    used: Option<Instant>,
}

pub struct MediaCache {
    manager: Arc<ConnectionManager>,
    directory: PathBuf,
    groups: Mutex<HashMap<String, Group>>,
    background: Arc<Semaphore>,
    next_file: std::sync::atomic::AtomicU64,
}

enum Kind {
    /// One file the player reads with byte ranges.
    Progressive,
    /// An HLS playlist; its segments are fetched ahead once it arrives.
    Playlist,
    /// One HLS segment or its initialization section.
    Segment,
}

/// What the cache handles, and the song each path belongs to.
fn classify(path: &str) -> Option<(Kind, String)> {
    let route = path.split('?').next().unwrap_or(path);
    let parts: Vec<&str> = route.trim_start_matches('/').split('/').collect();
    match parts.as_slice() {
        ["api", "providers", provider, "tracks", track, rest @ ..] => {
            let group = format!("/api/providers/{provider}/tracks/{track}");
            match rest {
                ["stream"] => Some((Kind::Progressive, group)),
                ["playlist.m3u8"] => Some((Kind::Playlist, group)),
                ["dash", "init"] => Some((Kind::Segment, group)),
                ["dash", number] if number.bytes().all(|byte| byte.is_ascii_digit()) => Some((Kind::Segment, group)),
                _ => None,
            }
        }
        ["api", "music", "local", "files", id] => Some((Kind::Progressive, format!("/api/music/local/files/{id}"))),
        _ => None,
    }
}

pub fn cacheable(path: &str) -> bool {
    classify(path).is_some()
}

impl MediaCache {
    pub fn new(manager: Arc<ConnectionManager>, directory: PathBuf) -> Result<Arc<Self>> {
        // Leftovers from an earlier run can never be served again. The directory itself stays,
        // with whatever attributes the app gave it (such as being left out of backups).
        std::fs::create_dir_all(&directory)?;
        for entry in std::fs::read_dir(&directory)?.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
        Ok(Arc::new(Self {
            manager,
            directory,
            groups: Mutex::new(HashMap::new()),
            background: Arc::new(Semaphore::new(BACKGROUND_DOWNLOADS)),
            next_file: Default::default(),
        }))
    }

    /// Starts downloading a song the player will need soon.
    pub fn prefetch(self: &Arc<Self>, path: &str) {
        if classify(path).is_some() {
            self.entry(path, false);
        }
    }

    fn entry(self: &Arc<Self>, path: &str, player: bool) -> Option<Arc<Entry>> {
        let (kind, group_key) = classify(path)?;
        let mut groups = self.groups.lock().ok()?;
        let group = groups.entry(group_key.clone()).or_default();
        // Prefetching never makes a song more recent than the one the player is reading.
        if player || group.used.is_none() {
            group.used = Some(Instant::now());
        }
        if let Some(entry) = group.entries.get(path) {
            let entry = entry.clone();
            if player {
                entry.urgent.notify_one();
            }
            return Some(entry);
        }
        let number = self.next_file.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let entry = Arc::new(Entry {
            file: self.directory.join(format!("{number}.part")),
            progress: watch::channel(Progress::default()).0,
            urgent: Arc::new(Notify::new()),
            task: Mutex::new(None),
        });
        if player {
            entry.urgent.notify_one();
        }
        group.entries.insert(path.to_owned(), entry.clone());
        // Evict the least recently played songs beyond the limit.
        while groups.len() > MAX_GROUPS {
            let Some(oldest) = groups
                .iter()
                .filter(|(key, _)| **key != group_key)
                .min_by_key(|(_, group)| group.used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(evicted) = groups.remove(&oldest) {
                // Each download holds its entry, so it has to be stopped for the file to go.
                for entry in evicted.entries.values() {
                    if let Some(task) = entry.task.lock().ok().and_then(|mut task| task.take()) {
                        task.abort();
                    }
                }
            }
        }
        drop(groups);
        let cache = self.clone();
        let download = entry.clone();
        let path = path.to_owned();
        let task = tokio::spawn(async move {
            // Ahead-of-time work waits its turn; the player's own requests go first.
            let _permit = tokio::select! {
                permit = cache.background.clone().acquire_owned() => permit.ok(),
                _ = download.urgent.notified() => None,
            };
            cache.download(&path, &download).await;
            if matches!(kind, Kind::Playlist) && download.progress.borrow().done {
                cache.prefetch_segments(&path, &download.file).await;
            }
        });
        if let Ok(mut slot) = entry.task.lock() {
            *slot = Some(task);
        }
        Some(entry)
    }

    async fn prefetch_segments(self: &Arc<Self>, playlist: &str, file: &PathBuf) {
        let Ok(text) = tokio::fs::read_to_string(file).await else { return };
        let route = playlist.split('?').next().unwrap_or(playlist);
        let base = &route[..route.rfind('/').map_or(0, |index| index + 1)];
        let mut uris = Vec::new();
        for line in text.lines().map(str::trim) {
            if let Some(map) = line.strip_prefix("#EXT-X-MAP:") {
                if let Some(uri) = map.split("URI=\"").nth(1).and_then(|rest| rest.split('"').next()) {
                    uris.push(uri.to_owned());
                }
            } else if !line.is_empty() && !line.starts_with('#') {
                uris.push(line.to_owned());
            }
        }
        for uri in uris {
            // Only relative segment names on the same song are fetched.
            if uri.contains("://") || uri.starts_with('/') {
                continue;
            }
            self.prefetch(&format!("{base}{uri}"));
        }
    }

    async fn download(&self, path: &str, entry: &Entry) {
        let Ok(mut file) = tokio::fs::File::create(&entry.file).await else {
            entry.progress.send_modify(|progress| progress.failed = Some((StatusCode::INTERNAL_SERVER_ERROR, "Could not cache audio on this device".into())));
            return;
        };
        let mut backoff = Duration::from_millis(250);
        loop {
            let from = entry.progress.borrow().downloaded;
            let mut request = Request::builder().method(Method::GET).uri(path);
            if from > 0 {
                request = request.header(header::RANGE, format!("bytes={from}-"));
            }
            let Ok(request) = request.body(Body::empty()) else { return };
            let before = from;
            match self.manager.request(request).await {
                Ok(response) => {
                    let status = response.status();
                    let headers = response.headers().clone();
                    let mut restart = false;
                    match status {
                        StatusCode::OK => {
                            restart = from > 0;
                            let total = content_length(&headers);
                            entry.progress.send_modify(|progress| progress.total = total);
                        }
                        StatusCode::PARTIAL_CONTENT => match content_range(&headers) {
                            Some((start, total)) if start == from => entry.progress.send_modify(|progress| {
                                if total.is_some() { progress.total = total; }
                            }),
                            _ => {
                                // The server sent a different range than asked; start over cleanly.
                                entry.progress.send_modify(|progress| progress.downloaded = 0);
                                let _ = file.set_len(0).await;
                                let _ = file.seek(SeekFrom::Start(0)).await;
                                tokio::time::sleep(backoff).await;
                                continue;
                            }
                        },
                        StatusCode::RANGE_NOT_SATISFIABLE if entry.progress.borrow().total == Some(from) => {
                            let _ = file.flush().await;
                            entry.progress.send_modify(|progress| progress.done = true);
                            return;
                        }
                        status if status.is_client_error() && !matches!(status, StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_MANY_REQUESTS | StatusCode::CONFLICT) => {
                            let bytes = http_body_util::Limited::new(response.into_body(), 4096).collect().await.map(|body| body.to_bytes()).unwrap_or_default();
                            entry.progress.send_modify(|progress| progress.failed = Some((status, String::from_utf8_lossy(&bytes).into_owned())));
                            return;
                        }
                        _ => {
                            tokio::time::sleep(backoff).await;
                            backoff = (backoff * 2).min(Duration::from_secs(3));
                            continue;
                        }
                    }
                    if restart {
                        entry.progress.send_modify(|progress| progress.downloaded = 0);
                        let _ = file.set_len(0).await;
                        let _ = file.seek(SeekFrom::Start(0)).await;
                    }
                    if let Some(content_type) = headers.get(header::CONTENT_TYPE) {
                        entry.progress.send_modify(|progress| progress.content_type = Some(content_type.clone()));
                    }
                    let mut body = response.into_body();
                    let finished = loop {
                        match tokio::time::timeout(STALL, body.frame()).await {
                            Ok(Some(Ok(frame))) => {
                                let Ok(data) = frame.into_data() else { continue };
                                if file.write_all(&data).await.is_err() || file.flush().await.is_err() {
                                    entry.progress.send_modify(|progress| progress.failed = Some((StatusCode::INSUFFICIENT_STORAGE, "This device ran out of space for audio".into())));
                                    return;
                                }
                                entry.progress.send_modify(|progress| progress.downloaded += data.len() as u64);
                            }
                            Ok(None) => break true,
                            // A failed or silent connection; resume from what arrived.
                            Ok(Some(Err(_))) | Err(_) => break false,
                        }
                    };
                    let progress = entry.progress.borrow().clone();
                    let complete = match progress.total {
                        Some(total) => progress.downloaded >= total,
                        None => finished,
                    };
                    if complete {
                        let _ = file.flush().await;
                        entry.progress.send_modify(|progress| {
                            progress.total = Some(progress.downloaded);
                            progress.done = true;
                        });
                        return;
                    }
                }
                Err(_) => {}
            }
            if entry.progress.borrow().downloaded > before {
                backoff = Duration::from_millis(250);
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(3));
        }
    }

    /// Answers the player from the downloaded copy, waiting for bytes still on their way.
    pub async fn serve(self: &Arc<Self>, path: &str, method: &Method, headers: &HeaderMap) -> Response {
        let Some(entry) = self.entry(path, true) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let mut progress = entry.progress.subscribe();
        let snapshot = match progress
            .wait_for(|progress| progress.total.is_some() || progress.done || progress.failed.is_some())
            .await
        {
            Ok(snapshot) => snapshot.clone(),
            Err(_) => return (StatusCode::SERVICE_UNAVAILABLE, "Audio download stopped").into_response(),
        };
        if let Some((status, message)) = snapshot.failed.filter(|_| snapshot.downloaded == 0 && !snapshot.done) {
            return (status, message).into_response();
        }
        let total = snapshot.total.unwrap_or(snapshot.downloaded);
        let range = headers.get(header::RANGE).and_then(|value| value.to_str().ok()).map(|value| parse_range(value, total));
        let (start, end) = match range {
            Some(Some(range)) => range,
            Some(None) => {
                let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                if let Ok(value) = format!("bytes */{total}").parse() {
                    response.headers_mut().insert(header::CONTENT_RANGE, value);
                }
                return response;
            }
            None => (0, total.saturating_sub(1)),
        };
        if !snapshot.done && start > snapshot.downloaded + FAR_SEEK {
            // A long jump ahead plays sooner straight from the server; the download carries on.
            return self.passthrough(path, headers).await;
        }
        let length = if total == 0 { 0 } else { end + 1 - start };
        let mut response = Response::builder()
            .status(if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, length);
        if range.is_some() {
            response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
        }
        if let Some(content_type) = snapshot.content_type {
            response = response.header(header::CONTENT_TYPE, content_type);
        }
        let body = if *method == Method::HEAD || length == 0 {
            Body::empty()
        } else {
            Body::from_stream(read_while_downloading(entry, start, start + length))
        };
        response.body(body).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    }

    async fn passthrough(&self, path: &str, headers: &HeaderMap) -> Response {
        let mut request = Request::builder().method(Method::GET).uri(path);
        if let Some(range) = headers.get(header::RANGE) {
            request = request.header(header::RANGE, range);
        }
        let Ok(request) = request.body(Body::empty()) else { return StatusCode::BAD_REQUEST.into_response() };
        match self.manager.request(request).await {
            Ok(response) => response.map(Body::new),
            Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "Selected Ambra server is offline").into_response(),
        }
    }
}

fn read_while_downloading(entry: Arc<Entry>, start: u64, end: u64) -> impl futures_util::Stream<Item = std::io::Result<Bytes>> + Send {
    let progress = entry.progress.subscribe();
    futures_util::stream::unfold((entry, progress, None::<tokio::fs::File>, start), move |(entry, mut progress, file, position)| async move {
        if position >= end {
            return None;
        }
        let snapshot = progress.wait_for(|p| p.downloaded > position || p.done || p.failed.is_some()).await.map(|snapshot| snapshot.clone());
        let available = match snapshot {
            Ok(snapshot) if snapshot.downloaded > position => snapshot.downloaded,
            Ok(snapshot) if snapshot.failed.is_some() => {
                let message = snapshot.failed.map(|(_, message)| message).unwrap_or_default();
                return Some((Err(std::io::Error::other(message)), (entry, progress, None, end)));
            }
            _ => return None,
        };
        let mut file = match file {
            Some(file) => file,
            None => match tokio::fs::File::open(&entry.file).await {
                Ok(mut file) => {
                    if let Err(error) = file.seek(SeekFrom::Start(position)).await {
                        return Some((Err(error), (entry, progress, None, end)));
                    }
                    file
                }
                Err(error) => return Some((Err(error), (entry, progress, None, end))),
            },
        };
        let wanted = (available.min(end) - position).min(CHUNK as u64) as usize;
        let mut buffer = vec![0; wanted];
        match file.read(&mut buffer).await {
            Ok(0) => Some((Err(std::io::Error::other("Cached audio ended early")), (entry, progress, None, end))),
            Ok(read) => {
                buffer.truncate(read);
                Some((Ok(Bytes::from(buffer)), (entry, progress, Some(file), position + read as u64)))
            }
            Err(error) => Some((Err(error), (entry, progress, None, end))),
        }
    })
}

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers.get(header::CONTENT_LENGTH)?.to_str().ok()?.parse().ok()
}

/// The first byte and the full size from `Content-Range: bytes start-end/total`.
fn content_range(headers: &HeaderMap) -> Option<(u64, Option<u64>)> {
    let value = headers.get(header::CONTENT_RANGE)?.to_str().ok()?.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let start = range.split_once('-')?.0.trim().parse().ok()?;
    Some((start, total.trim().parse().ok()))
}

/// One satisfiable byte range, inclusive, or None when it lies outside the file.
fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (first, last) = spec.split_once('-')?;
    if total == 0 {
        return None;
    }
    let (start, end) = if first.is_empty() {
        let suffix: u64 = last.parse().ok()?;
        (total.saturating_sub(suffix), total - 1)
    } else {
        let start: u64 = first.parse().ok()?;
        let end = if last.is_empty() { total - 1 } else { last.parse::<u64>().ok()?.min(total - 1) };
        (start, end)
    };
    (start <= end && start < total).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_audio_routes_are_cached_and_grouped_by_song() {
        assert!(matches!(classify("/api/providers/tidal/tracks/9/stream?q=1"), Some((Kind::Progressive, group)) if group == "/api/providers/tidal/tracks/9"));
        assert!(matches!(classify("/api/providers/tidal/tracks/9/playlist.m3u8"), Some((Kind::Playlist, _))));
        assert!(matches!(classify("/api/providers/tidal/tracks/9/dash/12"), Some((Kind::Segment, group)) if group == "/api/providers/tidal/tracks/9"));
        assert!(matches!(classify("/api/providers/tidal/tracks/9/dash/init?x"), Some((Kind::Segment, _))));
        assert!(matches!(classify("/api/music/local/files/abc"), Some((Kind::Progressive, _))));
        assert!(classify("/api/music/local/files/abc/palette").is_none());
        assert!(classify("/api/providers/tidal/tracks/9/metadata").is_none());
        assert!(classify("/api/session").is_none());
    }

    #[test]
    fn ranges_follow_rfc_7233() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-1", 100), None);
    }

    #[test]
    fn content_range_reads_start_and_total() {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_RANGE, "bytes 500-999/1000".parse().unwrap());
        assert_eq!(content_range(&headers), Some((500, Some(1000))));
        headers.insert(header::CONTENT_RANGE, "bytes 0-9/*".parse().unwrap());
        assert_eq!(content_range(&headers), Some((0, None)));
    }
}
