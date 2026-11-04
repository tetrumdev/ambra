//! Songs downloaded to this device, so they play without a server.
//!
//! While the app is open and linked to a server, it asks that server for downloads chosen
//! for it (`server/src/api/downloads.rs`), whether or not it is the shared output. Each song
//! is fetched once and re-encrypted with this installation's own key as it arrives
//! (`ambra-vault`), so the download folder never holds a playable audio file. The player
//! reads them through `ambra-offline:` sources, decrypting only what it plays.

use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::Duration,
};

use ambra_vault::{Entry, Quality, Reader, Store, file_stem, now_seconds};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

/// Sources the player reads from this device's downloads: `ambra-offline:<file>`.
pub const SCHEME: &str = "ambra-offline:";
/// Tells the app's screens that what's downloaded here changed.
const CHANGED_EVENT: &str = "offline-downloads-changed";
/// The song being downloaded now, and how far the batch has come.
const PROGRESS_EVENT: &str = "offline-download-progress";
const POLL_WAIT_SECONDS: u64 = 25;
const RETRY_AFTER: Duration = Duration::from_secs(5);
/// The address a linked-but-unconfigured app reports; nothing listens there.
const NO_SERVER: &str = "http://127.0.0.1:9";

static STORE: OnceLock<Arc<Store>> = OnceLock::new();
static COVERS: OnceLock<PathBuf> = OnceLock::new();

pub fn store() -> Option<&'static Arc<Store>> {
    STORE.get()
}

pub fn setup(app: &tauri::App) {
    let opened = (|| -> Result<Store, String> {
        let data = crate::persistent_data_directory(app.handle())?;
        // The key is kept apart from the downloads, so copying that folder doesn't copy it.
        let key = app.path().app_config_dir().map_err(|error| error.to_string())?.join("download-vault.key");
        Store::open(data.join("downloads"), &key).map_err(|error| error.to_string())
    })();
    match opened {
        Ok(store) => {
            let _ = STORE.set(Arc::new(store));
        }
        Err(error) => {
            eprintln!("Downloads are unavailable: {error}");
            return;
        }
    }
    // Covers aren't protected, and the asset protocol may show them from the cache.
    if let Ok(cache) = crate::cache_directory(app.handle()) {
        let covers = cache.join("covers").join("offline");
        let _ = fs::create_dir_all(&covers);
        let _ = COVERS.set(covers);
    }
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    tauri::async_runtime::spawn(collect(app.handle().clone(), sender));
    tauri::async_runtime::spawn(work(app.handle().clone(), receiver));
}

#[cfg(test)]
pub fn install_for_test(store: Store) {
    let _ = STORE.set(Arc::new(store));
}

/// The player's source for a downloaded song.
pub fn source_for(entry: &Entry) -> String {
    format!("{SCHEME}{}", entry.file)
}

/// A downloaded song's audio, decrypted as it's read.
pub struct OfflineMedia(Reader<File>);

impl Read for OfflineMedia {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.read(buffer)
    }
}

impl Seek for OfflineMedia {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.0.seek(position)
    }
}

impl symphonia::core::io::MediaSource for OfflineMedia {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.0.len())
    }
}

/// Opens an `ambra-offline:` source.
pub fn open(source: &str) -> Result<OfflineMedia, String> {
    let file = source.strip_prefix(SCHEME).ok_or("Not a downloaded song")?;
    if file.is_empty() || file.contains(['/', '\\']) || file.starts_with('.') {
        return Err("Invalid downloaded song".into());
    }
    let store = store().ok_or("Downloads are unavailable on this device")?;
    store
        .open_file(file)
        .map(OfflineMedia)
        .map_err(|error| format!("Could not open the downloaded song: {error}"))
}

/// This device's copy of the song a server URL plays, if it has one.
pub fn offline_source_for_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let path = &path[path.find("/api/")?..];
    let (provider, id) = if let Some(rest) = path.strip_prefix("/api/providers/") {
        let (provider, rest) = rest.split_once("/tracks/")?;
        (provider, rest.split('/').next()?)
    } else {
        let rest = path.strip_prefix("/api/downloads/play/")?;
        rest.split_once('/')?
    };
    let id = format!("{provider}:{}", urlencoding_decode(id));
    store()?.get(&id).map(|entry| source_for(&entry))
}

fn urlencoding_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(byte) = value.get(index + 1..index + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            decoded.push(byte);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn cover_path(entry_id: &str) -> Option<PathBuf> {
    COVERS.get().map(|covers| covers.join(format!("{}.jpg", file_stem(entry_id))))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineEntry {
    #[serde(flatten)]
    entry: Entry,
    /// The player's source for it.
    source: String,
    /// The saved cover's path, for the asset protocol.
    cover_path: Option<String>,
}

#[tauri::command]
pub fn offline_downloads() -> Vec<OfflineEntry> {
    let Some(store) = store() else { return Vec::new() };
    store
        .entries()
        .into_iter()
        .map(|entry| OfflineEntry {
            source: source_for(&entry),
            cover_path: cover_path(&entry.id).filter(|path| path.is_file()).map(|path| path.to_string_lossy().into_owned()),
            entry,
        })
        .collect()
}

#[tauri::command]
pub fn remove_offline_downloads(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let store = store().ok_or("Downloads are unavailable on this device")?;
    for id in &ids {
        store.remove(id).map_err(|error| error.to_string())?;
        if let Some(cover) = cover_path(id) {
            let _ = fs::remove_file(cover);
        }
    }
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackRef {
    provider: String,
    provider_track_id: String,
}

#[derive(Deserialize)]
struct Job {
    id: u64,
    tracks: Vec<TrackRef>,
    quality: Quality,
}

/// Where and as whom this app reaches its server right now.
#[derive(Clone)]
struct Server {
    base_url: String,
    token: Option<String>,
    client_id: String,
    client_name: String,
}

impl Server {
    fn current(app: &AppHandle) -> Option<Self> {
        let connection = app.try_state::<crate::server_link::ServerLink>()?.connection();
        let base_url = connection.base_url.trim_end_matches('/').to_owned();
        (base_url != NO_SERVER && !connection.client_id.is_empty()).then_some(Self {
            base_url,
            token: connection.token,
            client_id: connection.client_id,
            client_name: connection.client_name,
        })
    }

    fn request(&self, client: &reqwest::Client, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let request = client.request(method, format!("{}{path}", self.base_url));
        match &self.token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default()
}

/// Asks the server for this device's downloads for as long as the app runs. Downloading
/// happens in `work`, so the server keeps hearing from this device meanwhile.
async fn collect(app: AppHandle, jobs: tokio::sync::mpsc::UnboundedSender<(Server, Job)>) {
    let client = http_client();
    loop {
        let Some(server) = Server::current(&app) else {
            tokio::time::sleep(RETRY_AFTER).await;
            continue;
        };
        let path = format!(
            "/api/downloads/clients/{}/jobs?wait={POLL_WAIT_SECONDS}&name={}",
            server.client_id,
            encode(&server.client_name),
        );
        let response = server
            .request(&client, reqwest::Method::GET, &path)
            .timeout(Duration::from_secs(POLL_WAIT_SECONDS + 15))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                for job in response.json::<Vec<Job>>().await.unwrap_or_default() {
                    let _ = jobs.send((server.clone(), job));
                }
            }
            _ => tokio::time::sleep(RETRY_AFTER).await,
        }
    }
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

async fn work(app: AppHandle, mut jobs: tokio::sync::mpsc::UnboundedReceiver<(Server, Job)>) {
    let client = http_client();
    while let Some((server, job)) = jobs.recv().await {
        let (mut done, mut failed, mut last_error) = (0, 0, None::<String>);
        for track in &job.tracks {
            let id = format!("{}:{}", track.provider, track.provider_track_id);
            report(&app, &client, &server, &job, done, failed, Some(&id), last_error.as_deref(), false).await;
            match download(&client, &server, track, job.quality).await {
                Ok(()) => done += 1,
                Err(error) => {
                    eprintln!("Could not download {id}: {error}");
                    failed += 1;
                    last_error = Some(error);
                }
            }
            let _ = app.emit(CHANGED_EVENT, ());
        }
        report(&app, &client, &server, &job, done, failed, None, last_error.as_deref(), true).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn report(
    app: &AppHandle,
    client: &reqwest::Client,
    server: &Server,
    job: &Job,
    done: usize,
    failed: usize,
    current: Option<&str>,
    error: Option<&str>,
    finished: bool,
) {
    let body = json!({ "jobId": job.id, "done": done, "failed": failed, "current": current, "error": error, "finished": finished });
    let _ = app.emit(PROGRESS_EVENT, json!({ "total": job.tracks.len(), "done": done, "failed": failed, "current": current, "error": error, "finished": finished }));
    let path = format!("/api/downloads/clients/{}/progress", server.client_id);
    let _ = server.request(client, reqwest::Method::POST, &path).timeout(Duration::from_secs(10)).json(&body).send().await;
}

fn header(response: &reqwest::Response, name: &str) -> Option<String> {
    response.headers().get(name)?.to_str().ok().map(str::to_owned)
}

async fn download(client: &reqwest::Client, server: &Server, track: &TrackRef, quality: Quality) -> Result<(), String> {
    let store = store().ok_or("Downloads are unavailable on this device")?;
    let id = format!("{}:{}", track.provider, track.provider_track_id);
    if store.get(&id).is_some_and(|entry| entry.requested_quality == quality) {
        return Ok(());
    }
    let provider = encode(&track.provider);
    let track_id = encode(&track.provider_track_id);
    let metadata = server
        .request(client, reqwest::Method::GET, &format!("/api/providers/{provider}/tracks/{track_id}/metadata"))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !metadata.status().is_success() {
        return Err(server_error(metadata).await);
    }
    let metadata = metadata.json::<Value>().await.map_err(|error| error.to_string())?;

    let mut response = server
        .request(client, reqwest::Method::GET, &format!("/api/downloads/source/{provider}/{track_id}?quality={}", quality.as_str()))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(server_error(response).await);
    }
    let container = header(&response, "x-ambra-container")
        .filter(|container| matches!(container.as_str(), "flac" | "m4a" | "mp3" | "ogg"))
        .unwrap_or_else(|| "flac".into());
    let mime_type = header(&response, "content-type").unwrap_or_else(|| "audio/flac".into());
    let quality_label = header(&response, "x-ambra-quality")
        .map(|label| urlencoding_decode(&label))
        .unwrap_or_else(|| "Downloaded".into());
    let sample_rate_khz = header(&response, "x-ambra-sample-rate-khz").and_then(|value| value.parse().ok());
    let bit_depth = header(&response, "x-ambra-bit-depth").and_then(|value| value.parse().ok());
    let expected = response.content_length();

    let file = format!("{}.{container}", file_stem(&id));
    let mut pending = store.begin(&file).map_err(|error| error.to_string())?;
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        pending.writer().write_all(&chunk).map_err(|error| error.to_string())?;
    }
    if expected.is_some_and(|expected| expected != pending.writer().len()) {
        return Err("The download was cut short".into());
    }
    let size = store.finish(pending).map_err(|error| error.to_string())?;
    save_cover(client, server, &id, &metadata).await;
    store
        .record(Entry {
            id,
            provider: track.provider.clone(),
            provider_track_id: track.provider_track_id.clone(),
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
            cover_file: None,
        })
        .map_err(|error| error.to_string())
}

async fn server_error(response: reqwest::Response) -> String {
    let status = response.status();
    response
        .json::<Value>()
        .await
        .ok()
        .and_then(|body| body["error"].as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("The server answered {status}"))
}

/// Keeps the album cover beside the song, so it shows without a connection.
async fn save_cover(client: &reqwest::Client, server: &Server, id: &str, metadata: &Value) {
    let (Some(url), Some(path)) = (metadata["album"]["coverUrl"].as_str(), cover_path(id)) else { return };
    let request = if url.starts_with('/') {
        server.request(client, reqwest::Method::GET, url)
    } else if url.starts_with("https://") || url.starts_with("http://") {
        client.get(url)
    } else {
        return;
    };
    let Ok(response) = request.timeout(Duration::from_secs(30)).send().await else { return };
    if !response.status().is_success() {
        return;
    }
    if let Ok(bytes) = response.bytes().await
        && !bytes.is_empty()
    {
        let temporary = path.with_extension("tmp");
        if fs::write(&temporary, &bytes).is_ok() {
            let _ = fs::rename(temporary, path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_urls_name_their_song() {
        // Without a store nothing is downloaded, but the URL shapes still parse to nothing.
        assert_eq!(offline_source_for_url("http://127.0.0.1:1/api/providers/tidal/tracks/1/stream"), None);
        assert_eq!(urlencoding_decode("a%2Fb%20c"), "a/b c");
        assert_eq!(encode("My Mac"), "My%20Mac");
    }

    #[test]
    fn sources_cannot_leave_the_download_folder() {
        assert!(open("ambra-offline:../secret").is_err());
        assert!(open("ambra-offline:").is_err());
        assert!(open("file:///etc/passwd").is_err());
    }
}
