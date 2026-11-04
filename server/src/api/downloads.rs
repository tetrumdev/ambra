//! Downloads: songs saved encrypted, on the server or on the apps' own devices.
//!
//! A song downloaded to the server plays from that copy, so it keeps playing when its
//! service is signed out or unreachable. A song downloaded to a device is fetched from here
//! by that device's app (which re-encrypts it with its own key) and plays there without any
//! server. Devices ask for work by long-polling, so any open app can be chosen, whether or
//! not it is playing for the server.
//!
//! Copies are encrypted at rest (`ambra-vault`), so the download folder holds no playable
//! audio files.

use super::*;
use crate::flac_remux::Remuxer;
use ambra_vault::{Entry, Quality, Store, file_stem, now_seconds};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    sync::{
        Mutex as SyncMutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::{Notify, mpsc};

/// Apps long-poll for about 25 seconds, so one that hasn't asked for this long is closed.
const CLIENT_OFFLINE_AFTER: Duration = Duration::from_secs(40);
const MAX_WAIT_SECONDS: u64 = 30;
const JOBS_KEPT: usize = 50;
const MAX_TRACKS_PER_REQUEST: usize = 10_000;
const MAX_SEGMENTS: u32 = 20_000;
const STREAM_PIECE: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub(super) struct TrackRef {
    provider: MusicProvider,
    provider_track_id: String,
}

impl TrackRef {
    fn id(&self) -> String {
        format!("{}:{}", provider_slug(self.provider), self.provider_track_id)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientJob {
    id: u64,
    tracks: Vec<TrackRef>,
    quality: Quality,
}

struct ServerJob {
    id: u64,
    tracks: Vec<TrackRef>,
    quality: Quality,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobStatus {
    id: u64,
    /// `server` or `client`.
    target: &'static str,
    client_id: Option<String>,
    target_name: String,
    quality: Quality,
    total: usize,
    done: usize,
    failed: usize,
    /// The song being downloaded now.
    current: Option<String>,
    /// The last failure's reason.
    error: Option<String>,
    finished: bool,
    created_at: u64,
}

struct ClientAgent {
    name: String,
    seen: Instant,
    queue: VecDeque<ClientJob>,
    work: Arc<Notify>,
}

pub(super) struct Downloads {
    store: Result<Store, String>,
    clients: SyncMutex<HashMap<String, ClientAgent>>,
    jobs: SyncMutex<VecDeque<JobStatus>>,
    next_job: AtomicU64,
    server_jobs: mpsc::UnboundedSender<ServerJob>,
    server_receiver: SyncMutex<Option<mpsc::UnboundedReceiver<ServerJob>>>,
}

fn lock<T>(mutex: &SyncMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Downloads {
    pub(super) fn open() -> Self {
        // The key lives with the configuration, apart from the downloads themselves.
        Self::at(crate::storage::data_path("downloads"), &crate::storage::config_path("download-vault.key"))
    }

    pub(super) fn at(directory: PathBuf, key_path: &std::path::Path) -> Self {
        let store = Store::open(directory, key_path).map_err(|error| format!("Downloads are unavailable: {error}"));
        if let Err(error) = &store {
            eprintln!("{error}");
        }
        if let Ok(store) = &store {
            remove_leftovers(store);
        }
        let (server_jobs, receiver) = mpsc::unbounded_channel();
        Self {
            store,
            clients: SyncMutex::new(HashMap::new()),
            jobs: SyncMutex::new(VecDeque::new()),
            next_job: AtomicU64::new(1),
            server_jobs,
            server_receiver: SyncMutex::new(Some(receiver)),
        }
    }

    fn store(&self) -> Result<&Store, ApiError> {
        self.store.as_ref().map_err(|error| ApiError::service_unavailable(error.clone()))
    }

    /// The server's copy of `id`, if it has one.
    pub(super) fn server_entry(&self, id: &str) -> Option<Entry> {
        self.store.as_ref().ok()?.get(id)
    }

    fn update_job(&self, id: u64, change: impl FnOnce(&mut JobStatus)) {
        if let Some(job) = lock(&self.jobs).iter_mut().find(|job| job.id == id) {
            change(job);
        }
    }

    fn add_job(&self, job: JobStatus) {
        let mut jobs = lock(&self.jobs);
        jobs.push_back(job);
        while jobs.len() > JOBS_KEPT {
            // Finished jobs go first; running ones stay visible.
            match jobs.iter().position(|job| job.finished) {
                Some(index) => {
                    jobs.remove(index);
                }
                None => break,
            }
        }
    }

    fn online_clients(&self) -> Vec<(String, String)> {
        let mut clients = lock(&self.clients);
        clients.retain(|_, agent| agent.seen.elapsed() < CLIENT_OFFLINE_AFTER * 4 || !agent.queue.is_empty());
        let mut online = clients
            .iter()
            .filter(|(_, agent)| agent.seen.elapsed() < CLIENT_OFFLINE_AFTER)
            .map(|(id, agent)| (id.clone(), agent.name.clone()))
            .collect::<Vec<_>>();
        online.sort_by(|a, b| a.1.cmp(&b.1));
        online
    }
}

/// Copies that were mid-way when the server stopped.
fn remove_leftovers(store: &Store) {
    let Ok(listing) = fs::read_dir(store.directory()) else { return };
    for item in listing.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with("staging-") || name.contains(".frames.") {
            let _ = fs::remove_file(item.path());
        }
    }
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/downloads", get(list).post(create))
        .route("/api/downloads/remove", post(remove))
        .route("/api/downloads/clients", get(clients))
        .route("/api/downloads/clients/{client_id}/jobs", get(collect))
        .route("/api/downloads/clients/{client_id}/progress", post(progress))
        .route("/api/downloads/source/{provider}/{track_id}", get(source))
        .route("/api/downloads/play/{provider}/{track_id}", get(play))
}

/// Starts the worker that saves songs on the server, one at a time.
pub(super) fn start(state: AppState) {
    let Some(mut receiver) = lock(&state.downloads.server_receiver).take() else { return };
    tokio::spawn(async move {
        while let Some(job) = receiver.recv().await {
            providers_restored(state.providers_ready.clone(), PROVIDER_RESTORE_WAIT).await;
            for track in &job.tracks {
                state.downloads.update_job(job.id, |status| status.current = Some(track.id()));
                match save_on_server(&state, track, job.quality).await {
                    Ok(()) => state.downloads.update_job(job.id, |status| status.done += 1),
                    Err(error) => {
                        eprintln!("Could not download {} to the server: {error}", track.id());
                        state.downloads.update_job(job.id, |status| {
                            status.failed += 1;
                            status.error = Some(error);
                        });
                    }
                }
            }
            state.downloads.update_job(job.id, |status| {
                status.current = None;
                status.finished = true;
            });
        }
    });
}

/// A track as the app sees it once the server has its own copy: it plays from that copy.
pub(super) fn offline_track(mut track: TrackMetadata, entry: &Entry) -> TrackMetadata {
    track.playback = crate::models::PlaybackMetadata {
        kind: crate::models::PlaybackKind::Direct,
        url: format!("/api/downloads/play/{}/{}", entry.provider, urlencoding::encode(&entry.provider_track_id)),
    };
    track.quality = Some(entry.quality_label.clone());
    track.maximum_sampling_rate_khz = entry.sample_rate_khz.or(track.maximum_sampling_rate_khz);
    track.maximum_bit_depth = entry.bit_depth.or(track.maximum_bit_depth);
    track
}

fn speaks_for(caller: &crate::access::Caller, client_id: &str) -> bool {
    caller.client_id.as_deref().is_none_or(|id| id == client_id)
}

fn valid_client_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_track_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn parse_provider(provider: &str) -> Result<MusicProvider, ApiError> {
    match provider {
        "tidal" => Ok(MusicProvider::Tidal),
        "qobuz" => Ok(MusicProvider::Qobuz),
        "spotify" => Ok(MusicProvider::Spotify),
        _ => Err(ApiError::not_found(format!("Music provider '{provider}' can't be downloaded from"))),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResponse {
    entries: Vec<Entry>,
    jobs: Vec<JobStatus>,
}

async fn list(State(state): State<AppState>) -> Result<Json<ListResponse>, ApiError> {
    let entries = state.downloads.store.as_ref().map(Store::entries).unwrap_or_default();
    let jobs = lock(&state.downloads.jobs).iter().cloned().collect();
    Ok(Json(ListResponse { entries, jobs }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Target {
    Server,
    Clients,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRequest {
    tracks: Vec<TrackRef>,
    #[serde(default)]
    quality: Quality,
    target: Target,
    #[serde(default)]
    client_ids: Vec<String>,
}

#[derive(Serialize)]
struct CreateResponse {
    jobs: Vec<JobStatus>,
}

async fn create(State(state): State<AppState>, Json(request): Json<CreateRequest>) -> Result<Json<CreateResponse>, ApiError> {
    let mut seen = HashSet::new();
    let tracks = request.tracks.into_iter().filter(|track| seen.insert(track.clone())).collect::<Vec<_>>();
    if tracks.is_empty() {
        return Err(ApiError::bad_request("Choose at least one song to download"));
    }
    if tracks.len() > MAX_TRACKS_PER_REQUEST {
        return Err(ApiError::bad_request(format!("At most {MAX_TRACKS_PER_REQUEST} songs can be downloaded at once")));
    }
    if let Some(track) = tracks.iter().find(|track| !valid_track_id(&track.provider_track_id)) {
        return Err(ApiError::bad_request(format!("'{}' is not a track ID", track.provider_track_id)));
    }
    let downloads = &state.downloads;
    let new_status = |target, client_id: Option<String>, target_name: String| JobStatus {
        id: downloads.next_job.fetch_add(1, Ordering::Relaxed),
        target,
        client_id,
        target_name,
        quality: request.quality,
        total: tracks.len(),
        done: 0,
        failed: 0,
        current: None,
        error: None,
        finished: false,
        created_at: now_seconds(),
    };
    let mut created = Vec::new();
    match request.target {
        Target::Server => {
            downloads.store()?;
            let status = new_status("server", None, "Server".into());
            downloads
                .server_jobs
                .send(ServerJob { id: status.id, tracks, quality: request.quality })
                .map_err(|_| ApiError::service_unavailable("The server isn't taking downloads right now"))?;
            downloads.add_job(status.clone());
            created.push(status);
        }
        Target::Clients => {
            if request.client_ids.is_empty() {
                return Err(ApiError::bad_request("Choose at least one device"));
            }
            let online = downloads.online_clients().into_iter().collect::<HashMap<_, _>>();
            let missing = request.client_ids.iter().filter(|id| !online.contains_key(*id)).count();
            if missing > 0 {
                return Err(ApiError::service_unavailable(if missing == 1 {
                    "A device you chose has closed AMBRA".to_owned()
                } else {
                    format!("{missing} devices you chose have closed AMBRA")
                }));
            }
            let mut clients = lock(&downloads.clients);
            for client_id in &request.client_ids {
                let Some(agent) = clients.get_mut(client_id) else { continue };
                let status = new_status("client", Some(client_id.clone()), agent.name.clone());
                agent.queue.push_back(ClientJob { id: status.id, tracks: tracks.clone(), quality: request.quality });
                agent.work.notify_one();
                created.push(status);
            }
            drop(clients);
            for status in &created {
                downloads.add_job(status.clone());
            }
        }
    }
    Ok(Json(CreateResponse { jobs: created }))
}

#[derive(Deserialize)]
struct RemoveRequest {
    ids: Vec<String>,
}

async fn remove(State(state): State<AppState>, Json(request): Json<RemoveRequest>) -> Result<StatusCode, ApiError> {
    let store = state.downloads.store()?;
    for id in &request.ids {
        store.remove(id).map_err(ApiError::internal)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientView {
    id: String,
    name: String,
}

async fn clients(State(state): State<AppState>) -> Json<Vec<ClientView>> {
    Json(state.downloads.online_clients().into_iter().map(|(id, name)| ClientView { id, name }).collect())
}

#[derive(Deserialize)]
struct CollectQuery {
    wait: Option<u64>,
    name: Option<String>,
}

/// An app's long poll: it is open while it asks, and gets the downloads chosen for it.
async fn collect(
    State(state): State<AppState>,
    Extension(caller): Extension<crate::access::Caller>,
    Path(client_id): Path<String>,
    Query(query): Query<CollectQuery>,
) -> Response {
    if !valid_client_id(&client_id) {
        return ApiError::bad_request("Invalid device ID").into_response();
    }
    if !speaks_for(&caller, &client_id) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Only that device can collect its downloads" }))).into_response();
    }
    let name = query.name.map(|name| name.trim().chars().take(64).collect::<String>()).filter(|name| !name.is_empty());
    let take = |downloads: &Downloads| {
        let mut clients = lock(&downloads.clients);
        let agent = clients.entry(client_id.clone()).or_insert_with(|| ClientAgent {
            name: name.clone().unwrap_or_else(|| "AMBRA".into()),
            seen: Instant::now(),
            queue: VecDeque::new(),
            work: Arc::new(Notify::new()),
        });
        agent.seen = Instant::now();
        if let Some(name) = &name {
            agent.name.clone_from(name);
        }
        (agent.queue.drain(..).collect::<Vec<_>>(), agent.work.clone())
    };
    let (jobs, work) = take(&state.downloads);
    if !jobs.is_empty() {
        return Json(jobs).into_response();
    }
    let wait = query.wait.unwrap_or(0).min(MAX_WAIT_SECONDS);
    if wait > 0 {
        let _ = tokio::time::timeout(Duration::from_secs(wait), work.notified()).await;
    }
    Json(take(&state.downloads).0).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressReport {
    job_id: u64,
    done: usize,
    failed: usize,
    current: Option<String>,
    error: Option<String>,
    finished: bool,
}

async fn progress(
    State(state): State<AppState>,
    Extension(caller): Extension<crate::access::Caller>,
    Path(client_id): Path<String>,
    Json(report): Json<ProgressReport>,
) -> StatusCode {
    if !speaks_for(&caller, &client_id) {
        return StatusCode::FORBIDDEN;
    }
    state.downloads.update_job(report.job_id, |status| {
        if status.client_id.as_deref() == Some(client_id.as_str()) {
            status.done = report.done.min(status.total);
            status.failed = report.failed.min(status.total);
            status.current = report.current;
            if report.error.is_some() {
                status.error = report.error;
            }
            status.finished = report.finished;
        }
    });
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
struct SourceQuery {
    quality: Option<String>,
}

/// One song's audio at the asked quality, decrypted, for an app downloading it. The server's
/// own copy is used when it matches; otherwise the song is fetched from its service for this.
async fn source(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
    Query(query): Query<SourceQuery>,
) -> Result<Response, ApiError> {
    let track = TrackRef { provider: parse_provider(&provider)?, provider_track_id: track_id };
    if !valid_track_id(&track.provider_track_id) {
        return Err(ApiError::bad_request("Invalid track ID"));
    }
    let quality = match query.quality.as_deref() {
        None => Quality::Max,
        Some(value) => Quality::parse(value).ok_or_else(|| ApiError::bad_request(format!("Unknown quality '{value}'")))?,
    };
    let store = state.downloads.store()?;
    let (file, info, staging) = match store.get(&track.id()).filter(|entry| entry.requested_quality == quality) {
        Some(entry) => {
            let info = Produced {
                file: entry.file.clone(),
                container: entry.container.clone(),
                mime_type: entry.mime_type.clone(),
                quality_label: entry.quality_label.clone(),
                sample_rate_khz: entry.sample_rate_khz,
                bit_depth: entry.bit_depth,
                size: entry.size_bytes,
            };
            (entry.file, info, false)
        }
        None => {
            providers_restored(state.providers_ready.clone(), PROVIDER_RESTORE_WAIT).await;
            let mut suffix = [0_u8; 6];
            getrandom::fill(&mut suffix).map_err(|error| ApiError::internal(error.to_string()))?;
            let suffix = suffix.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
            let stem = format!("staging-{}-{suffix}", file_stem(&track.id()));
            let produced = produce(&state, store, &track, quality, &stem, None).await.map_err(ApiError::upstream)?;
            (produced.file.clone(), produced, true)
        }
    };
    let mut response = decrypted_response(&state, file, staging, None, &info.mime_type)?;
    let headers = response.headers_mut();
    let mut header = |name: &'static str, value: String| {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(name, value);
        }
    };
    header("x-ambra-container", info.container.clone());
    header("x-ambra-quality", urlencoding::encode(&info.quality_label).into_owned());
    if let Some(rate) = info.sample_rate_khz {
        header("x-ambra-sample-rate-khz", rate.to_string());
    }
    if let Some(depth) = info.bit_depth {
        header("x-ambra-bit-depth", depth.to_string());
    }
    Ok(response)
}

/// The server's copy, decrypted, with byte ranges for seeking.
async fn play(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let id = format!("{}:{track_id}", provider_slug(parse_provider(&provider)?));
    let entry = state
        .downloads
        .server_entry(&id)
        .ok_or_else(|| ApiError::not_found(format!("{id} isn't downloaded to the server")))?;
    decrypted_response(&state, entry.file, false, Some(&headers), &entry.mime_type)
}

fn decrypted_response(
    state: &AppState,
    file: String,
    staging: bool,
    request: Option<&HeaderMap>,
    mime_type: &str,
) -> Result<Response, ApiError> {
    let store = state.downloads.store()?;
    let reader = store.open_file(&file).map_err(ApiError::internal)?;
    let total = reader.len();
    let (start, end_inclusive, partial) = match request {
        Some(headers) => requested_byte_range(headers.get(RANGE), total)?,
        None => (0, total.saturating_sub(1), false),
    };
    let length = if total == 0 { 0 } else { end_inclusive - start + 1 };
    let (sender, receiver) = mpsc::channel::<io::Result<Bytes>>(4);
    let downloads = state.downloads.clone();
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let result = (|| -> io::Result<()> {
            io::Seek::seek(&mut reader, io::SeekFrom::Start(start))?;
            let mut remaining = length;
            let mut buffer = vec![0; STREAM_PIECE];
            while remaining > 0 {
                let want = (remaining as usize).min(STREAM_PIECE);
                let read = reader.read(&mut buffer[..want])?;
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
        if staging && let Ok(store) = downloads.store() {
            let _ = fs::remove_file(store.path(&file));
        }
    });
    let mut response = Response::builder()
        .status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(CONTENT_TYPE, mime_type)
        .header(CONTENT_LENGTH, length)
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from_stream(ReceiverStream::new(receiver)))
        .map_err(ApiError::internal)?;
    if partial {
        response.headers_mut().insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end_inclusive}/{total}")).map_err(ApiError::internal)?,
        );
    }
    Ok(response)
}

async fn save_on_server(state: &AppState, track: &TrackRef, quality: Quality) -> Result<(), String> {
    let store = state.downloads.store().map_err(|error| error.message)?;
    let id = track.id();
    if store.get(&id).is_some_and(|entry| entry.requested_quality == quality) {
        return Ok(());
    }
    let entry = LibraryEntry { provider: track.provider, provider_track_id: track.provider_track_id.clone() };
    let metadata = load_provider_track(state, &entry).await.map_err(|error| error.to_string())?;
    let produced = produce(state, store, track, quality, &file_stem(&id), Some(metadata.duration_seconds)).await?;
    store
        .record(Entry {
            id,
            provider: provider_slug(track.provider).into(),
            provider_track_id: track.provider_track_id.clone(),
            file: produced.file,
            container: produced.container,
            mime_type: produced.mime_type,
            requested_quality: quality,
            quality_label: produced.quality_label,
            sample_rate_khz: produced.sample_rate_khz,
            bit_depth: produced.bit_depth,
            size_bytes: produced.size,
            downloaded_at: now_seconds(),
            metadata: serde_json::to_value(&metadata).map_err(|error| error.to_string())?,
            cover_file: None,
        })
        .map_err(|error| error.to_string())
}

struct Produced {
    file: String,
    container: String,
    mime_type: String,
    quality_label: String,
    sample_rate_khz: Option<f64>,
    bit_depth: Option<u32>,
    size: u64,
}

fn container_for_mime(mime_type: &str, fallback: &str) -> String {
    let mime = mime_type.to_ascii_lowercase();
    if mime.contains("flac") {
        "flac"
    } else if mime.contains("mpeg") || mime.contains("mp3") {
        "mp3"
    } else if mime.contains("ogg") || mime.contains("vorbis") {
        "ogg"
    } else if mime.contains("mp4") || mime.contains("m4a") || mime.contains("aac") {
        "m4a"
    } else {
        fallback
    }
    .to_owned()
}

fn mime_for_container(container: &str) -> &'static str {
    match container {
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        _ => "audio/mp4",
    }
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Streams `url` into `writer`.
async fn fetch_into(client: &reqwest::Client, url: &str, writer: &mut impl Write) -> Result<(), String> {
    let response = client.get(url).send().await.map_err(text)?.error_for_status().map_err(text)?;
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        writer.write_all(&chunk.map_err(text)?).map_err(text)?;
    }
    Ok(())
}

/// Fetches `track` at `quality` from its service and saves it encrypted as `{stem}.{container}`.
async fn produce(
    state: &AppState,
    store: &Store,
    track: &TrackRef,
    quality: Quality,
    stem: &str,
    duration_seconds: Option<u64>,
) -> Result<Produced, String> {
    let id = &track.provider_track_id;
    match track.provider {
        MusicProvider::Qobuz => {
            use qbz_models::Quality as QobuzQuality;
            let requested = match quality {
                Quality::Max => QobuzQuality::UltraHiRes,
                Quality::HiRes => QobuzQuality::HiRes,
                Quality::Cd => QobuzQuality::Lossless,
                Quality::Lossy => QobuzQuality::Mp3,
            };
            let source = qobuz_provider(state).map_err(|error| error.message)?.download_source(id, requested).await.map_err(text)?;
            let container = container_for_mime(&source.mime_type, "flac");
            let file = format!("{stem}.{container}");
            let mut pending = store.begin(&file).map_err(text)?;
            fetch_into(&state.http_client, &source.url, pending.writer()).await?;
            let size = store.finish(pending).map_err(text)?;
            Ok(Produced {
                file,
                mime_type: mime_for_container(&container).into(),
                container,
                quality_label: source.quality,
                sample_rate_khz: source.sampling_rate_khz,
                bit_depth: source.bit_depth,
                size,
            })
        }
        MusicProvider::Tidal => {
            let provider = tidal_provider(state).map_err(|error| error.message)?;
            let audio_quality = match quality {
                // Tidal has no tier between CD and its best (up to 24-bit/192 kHz).
                Quality::Max | Quality::HiRes => "HI_RES_LOSSLESS",
                Quality::Cd => "LOSSLESS",
                Quality::Lossy => "HIGH",
            };
            let duration = match duration_seconds {
                Some(duration) => duration,
                None => provider.track_metadata(id).await.map_err(text)?.duration_seconds,
            };
            let download = provider.download_source(id, audio_quality, duration).await.map_err(text)?;
            match download.source {
                PlaybackSource::Direct { url, mime_type } => {
                    let container = container_for_mime(&mime_type, "m4a");
                    let file = format!("{stem}.{container}");
                    let mut pending = store.begin(&file).map_err(text)?;
                    fetch_into(&state.http_client, &url, pending.writer()).await?;
                    let size = store.finish(pending).map_err(text)?;
                    Ok(Produced {
                        file,
                        mime_type: mime_for_container(&container).into(),
                        container,
                        quality_label: download.quality,
                        sample_rate_khz: download.sampling_rate_khz,
                        bit_depth: download.bit_depth,
                        size,
                    })
                }
                PlaybackSource::Dash { initialization_url, media_url_template, start_number, segment_count, .. } => {
                    let init = download_media_bytes(&state.http_client, &initialization_url).await.map_err(|error| error.message)?;
                    let segment_url = |number: u32| media_url_template.replace("$Number$", &number.to_string());
                    let last = segment_count.map_or(start_number.saturating_add(MAX_SEGMENTS), |count| start_number.saturating_add(count));
                    let known_count = segment_count.is_some();
                    let (file, container, size) = if let Some(mut remuxer) = Remuxer::new(&init) {
                        // Frames first (the header needs their total length), then the file.
                        let frames_file = format!("{stem}.frames");
                        let mut frames = store.begin(&frames_file).map_err(text)?;
                        for number in start_number..last {
                            let segment = match download_media_bytes(&state.http_client, &segment_url(number)).await {
                                Ok(segment) => segment,
                                Err(_) if !known_count && number > start_number => break,
                                Err(error) => return Err(error.message),
                            };
                            remuxer.push_segment(&segment, frames.writer()).map_err(text)?;
                        }
                        store.finish(frames).map_err(text)?;
                        let file = format!("{stem}.flac");
                        let header = remuxer.header();
                        let assembled = tokio::task::block_in_place(|| -> io::Result<u64> {
                            let mut pending = store.begin(&file)?;
                            pending.writer().write_all(&header)?;
                            let mut frames = store.open_file(&frames_file)?;
                            io::copy(&mut frames, pending.writer())?;
                            store.finish(pending)
                        });
                        let _ = fs::remove_file(store.path(&frames_file));
                        (file, "flac".to_owned(), assembled.map_err(text)?)
                    } else {
                        let file = format!("{stem}.m4a");
                        let mut pending = store.begin(&file).map_err(text)?;
                        pending.writer().write_all(&init).map_err(text)?;
                        for number in start_number..last {
                            let segment = match download_media_bytes(&state.http_client, &segment_url(number)).await {
                                Ok(segment) => segment,
                                Err(_) if !known_count && number > start_number => break,
                                Err(error) => return Err(error.message),
                            };
                            pending.writer().write_all(&segment).map_err(text)?;
                        }
                        let size = store.finish(pending).map_err(text)?;
                        (file, "m4a".to_owned(), size)
                    };
                    Ok(Produced {
                        file,
                        mime_type: mime_for_container(&container).into(),
                        container,
                        quality_label: download.quality,
                        sample_rate_khz: download.sampling_rate_khz,
                        bit_depth: download.bit_depth,
                        size,
                    })
                }
            }
        }
        MusicProvider::Spotify => {
            let prepared = spotify_provider(state).await.map_err(|error| error.message)?.prepare_download(id).await.map_err(text)?;
            let length = prepared.content_length();
            let container = prepared.container().to_owned();
            let quality_label = prepared.quality_label().to_owned();
            let file = format!("{stem}.{container}");
            let mut pending = store.begin(&file).map_err(text)?;
            let mut receiver = prepared.into_byte_stream(0, length.saturating_sub(1));
            while let Some(chunk) = receiver.recv().await {
                pending.writer().write_all(&chunk.map_err(text)?).map_err(text)?;
            }
            if pending.writer().len() != length {
                return Err("Spotify ended the download early".into());
            }
            let size = store.finish(pending).map_err(text)?;
            Ok(Produced {
                file,
                mime_type: mime_for_container(&container).into(),
                container,
                quality_label,
                sample_rate_khz: None,
                bit_depth: None,
                size,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn request(method: &str, uri: &str, body: Option<serde_json::Value>) -> Request {
        let builder = axum::http::Request::builder().method(method).uri(uri);
        match body {
            Some(body) => builder.header(CONTENT_TYPE, "application/json").body(Body::from(body.to_string())).unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        }
    }

    async fn send(app: &Router, request: Request) -> (StatusCode, Bytes) {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        (status, response.into_body().collect().await.unwrap().to_bytes())
    }

    fn json(bytes: &Bytes) -> serde_json::Value {
        serde_json::from_slice(bytes).unwrap()
    }

    #[tokio::test]
    async fn an_open_app_collects_its_downloads_and_server_copies_play_in_ranges() {
        let directory = std::env::temp_dir().join(format!("ambra-downloads-test-{}-{}", std::process::id(), now_seconds()));
        let state = super::super::discover::tests::state(&directory);
        let app = routes()
            .layer(Extension(crate::access::Caller { client_id: None }))
            .with_state(state.clone());

        // Asking for work is what makes an app choosable.
        let (status, body) = send(&app, request("GET", "/api/downloads/clients/laptop/jobs?name=Laptop", None)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json(&body), serde_json::json!([]));
        let (_, body) = send(&app, request("GET", "/api/downloads/clients", None)).await;
        assert_eq!(json(&body), serde_json::json!([{ "id": "laptop", "name": "Laptop" }]));

        let track = serde_json::json!([{ "provider": "tidal", "providerTrackId": "1" }]);
        let (status, _) = send(&app, request("POST", "/api/downloads", Some(serde_json::json!({ "tracks": track, "target": "clients", "clientIds": ["closed"] })))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        let (status, body) = send(&app, request("POST", "/api/downloads", Some(serde_json::json!({ "tracks": track, "target": "clients", "clientIds": ["laptop"] })))).await;
        assert_eq!(status, StatusCode::OK);
        let job = json(&body)["jobs"][0].clone();
        assert_eq!(job["quality"], "max");
        assert_eq!(job["targetName"], "Laptop");

        let (_, body) = send(&app, request("GET", "/api/downloads/clients/laptop/jobs", None)).await;
        let collected = json(&body);
        assert_eq!(collected[0]["id"], job["id"]);
        assert_eq!(collected[0]["tracks"], track);
        let (status, _) = send(&app, request("POST", "/api/downloads/clients/laptop/progress", Some(serde_json::json!({ "jobId": job["id"], "done": 1, "failed": 0, "finished": true })))).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, body) = send(&app, request("GET", "/api/downloads", None)).await;
        assert_eq!(json(&body)["jobs"][0]["finished"], true);
        assert_eq!(json(&body)["jobs"][0]["done"], 1);

        // A copy on the server plays decrypted, in byte ranges.
        let store = state.downloads.store().unwrap();
        let audio = (0..2000_u32).map(|index| (index % 251) as u8).collect::<Vec<_>>();
        let mut pending = store.begin("tidal-2.flac").unwrap();
        pending.writer().write_all(&audio).unwrap();
        store.finish(pending).unwrap();
        store.record(Entry {
            id: "tidal:2".into(), provider: "tidal".into(), provider_track_id: "2".into(), file: "tidal-2.flac".into(),
            container: "flac".into(), mime_type: "audio/flac".into(), requested_quality: Quality::Max, quality_label: "24-bit FLAC".into(),
            sample_rate_khz: Some(192.0), bit_depth: Some(24), size_bytes: 2000, downloaded_at: 0, metadata: serde_json::Value::Null, cover_file: None,
        }).unwrap();
        let mut ranged = request("GET", "/api/downloads/play/tidal/2", None);
        ranged.headers_mut().insert(RANGE, HeaderValue::from_static("bytes=100-199"));
        let response = app.clone().oneshot(ranged).await.unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes 100-199/2000");
        assert_eq!(response.into_body().collect().await.unwrap().to_bytes().as_ref(), &audio[100..200]);
        let (status, _) = send(&app, request("GET", "/api/downloads/play/tidal/3", None)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, _) = send(&app, request("POST", "/api/downloads/remove", Some(serde_json::json!({ "ids": ["tidal:2"] })))).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(state.downloads.server_entry("tidal:2").is_none());
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn another_device_cannot_take_an_apps_downloads() {
        let directory = std::env::temp_dir().join(format!("ambra-downloads-guard-{}-{}", std::process::id(), now_seconds()));
        let state = super::super::discover::tests::state(&directory);
        let app = routes()
            .layer(Extension(crate::access::Caller { client_id: Some("phone".into()) }))
            .with_state(state);
        let (status, _) = send(&app, request("GET", "/api/downloads/clients/laptop/jobs", None)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = send(&app, request("GET", "/api/downloads/clients/phone/jobs", None)).await;
        assert_eq!(status, StatusCode::OK);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn containers_follow_the_services_mime_types() {
        assert_eq!(container_for_mime("audio/flac", "m4a"), "flac");
        assert_eq!(container_for_mime("audio/mp4", "flac"), "m4a");
        assert_eq!(container_for_mime("audio/mpeg", "flac"), "mp3");
        assert_eq!(container_for_mime("audio/ogg", "flac"), "ogg");
        assert_eq!(container_for_mime("", "flac"), "flac");
    }

    #[test]
    fn only_safe_ids_reach_the_file_system() {
        assert!(valid_track_id("12345"));
        assert!(valid_track_id("4uLU6hMCjMI75M1A2tKUQC"));
        assert!(!valid_track_id("../etc"));
        assert!(!valid_track_id(""));
        assert!(valid_client_id("abc-123"));
        assert!(!valid_client_id("a/b"));
    }
}
