//! Optional vocal timing: jobs that run the vocal separation model (`crate::vocal_timing`) over
//! songs, the cache of the vocal curves they produce, the model's install, and the routes.
//!
//! A song is analyzed when its lyrics are asked for: at once when it is playing, after the
//! songs playing now when the app asks ahead of playback. Lyrics asked for while it runs say
//! so (`vocalTiming: "pending"`), and the app asks again once the curve is ready.
use super::*;
use crate::vocal_timing::{Budget, MODEL_BYTES, MODEL_URL, Progress, Separator, verify_model, vocal_power};
use ambra_vault::Store;
use sha2::Digest;
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{Mutex as SyncMutex, atomic::{AtomicBool, Ordering}},
};
use symphonia::core::io::MediaSource;
use tokio::sync::Notify;

/// Changing how curves are measured changes this, so older ones are measured again.
const CURVE_MAGIC: &[u8; 4] = b"AVT1";
/// A song that could not be analyzed is tried again after this long.
const RETRY_FAILED: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
enum Model {
    Off,
    Downloading { received: u64, total: u64 },
    Ready,
    Failed { error: String },
}

struct Job {
    provider: String,
    track_id: String,
    background: bool,
    /// What was finished before a song playing now cut this job off; it carries on from there.
    progress: Progress,
    /// The streamed song's scratch copy (file, container), kept while the job waits to resume.
    copy: Option<(String, String)>,
}

impl Job {
    fn key(&self) -> String {
        format!("{}:{}", self.provider, self.track_id)
    }
}

pub(super) struct VocalTiming {
    directory: PathBuf,
    model: SyncMutex<Model>,
    separator: SyncMutex<Option<Arc<Separator>>>,
    queue: SyncMutex<VecDeque<Job>>,
    /// Songs queued or being analyzed.
    pending: SyncMutex<HashSet<String>>,
    failed: SyncMutex<HashMap<String, Instant>>,
    /// The running job's key, whether it waits behind other songs, and its cancel flag.
    running: SyncMutex<Option<(String, bool, Arc<AtomicBool>)>>,
    work: Notify,
    scratch: Result<Store, String>,
}

fn lock<T>(mutex: &SyncMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

impl VocalTiming {
    pub(super) fn open() -> Self {
        // Scratch copies share the downloads' key, which lives with the configuration.
        Self::at(crate::storage::data_path("vocal-timing"), &crate::storage::config_path("download-vault.key"))
    }

    pub(super) fn at(directory: PathBuf, key_path: &std::path::Path) -> Self {
        let scratch = Store::open(directory.join("audio"), key_path)
            .map_err(|error| format!("Vocal timing can't store audio: {error}"));
        if let Ok(store) = &scratch
            && let Ok(listing) = fs::read_dir(store.directory())
        {
            // Copies left by an analysis the server stopped during.
            for item in listing.flatten() {
                let _ = fs::remove_file(item.path());
            }
        }
        let enabled = directory.join("enabled").exists();
        let model = if !enabled {
            Model::Off
        } else if verify_model(&directory.join("model.onnx")) {
            Model::Ready
        } else {
            Model::Downloading { received: 0, total: MODEL_BYTES }
        };
        Self {
            directory,
            model: SyncMutex::new(model),
            separator: SyncMutex::new(None),
            queue: SyncMutex::new(VecDeque::new()),
            pending: SyncMutex::new(HashSet::new()),
            failed: SyncMutex::new(HashMap::new()),
            running: SyncMutex::new(None),
            work: Notify::new(),
            scratch,
        }
    }

    fn ready(&self) -> bool {
        matches!(*lock(&self.model), Model::Ready)
    }

    fn curve_path(&self, key: &str) -> PathBuf {
        let digest = crate::vocal_timing::hex(&sha2::Sha256::digest(key.as_bytes()));
        self.directory.join("curves").join(format!("{digest}.bin"))
    }

    fn cached(&self, key: &str) -> Option<Vec<f64>> {
        let bytes = fs::read(self.curve_path(key)).ok()?;
        let body = bytes.strip_prefix(CURVE_MAGIC.as_slice())?;
        (body.len() % 4 == 0).then(|| {
            body.chunks_exact(4)
                .map(|value| f64::from(f32::from_le_bytes(value.try_into().unwrap())))
                .collect()
        })
    }

    fn save(&self, key: &str, power: &[f64]) -> io::Result<()> {
        let path = self.curve_path(key);
        fs::create_dir_all(path.parent().unwrap())?;
        let mut bytes = CURVE_MAGIC.to_vec();
        for value in power {
            bytes.extend_from_slice(&(*value as f32).to_le_bytes());
        }
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, bytes)?;
        fs::rename(temporary, path)
    }

    /// The song's vocal curve if it is ready; otherwise it is queued and `None` is returned.
    /// `Err` when vocal timing is off or the song can't be analyzed.
    fn curve(&self, provider: &str, track_id: &str, background: bool) -> Result<Option<Vec<f64>>, ()> {
        if !self.ready() {
            return Err(());
        }
        let job = Job { provider: provider.to_owned(), track_id: track_id.to_owned(), background, progress: Progress::default(), copy: None };
        let key = job.key();
        if let Some(curve) = self.cached(&key) {
            return Ok(Some(curve));
        }
        if lock(&self.failed).get(&key).is_some_and(|at| at.elapsed() < RETRY_FAILED) {
            return Err(());
        }
        let mut queue = lock(&self.queue);
        if lock(&self.pending).insert(key.clone()) {
            if background { queue.push_back(job) } else { queue.push_front(job) }
        } else if !background {
            // Asked for while playing: it moves ahead of songs that are only coming up.
            if let Some(index) = queue.iter().position(|queued| queued.key() == key) {
                let mut job = queue.remove(index).unwrap();
                job.background = false;
                queue.push_front(job);
            }
        }
        drop(queue);
        // A song coming up gives way to one playing now; it is analyzed again after.
        if !background
            && let Some((running, true, cancel)) = lock(&self.running).as_ref()
            && *running != key
        {
            cancel.store(true, Ordering::Relaxed);
        }
        self.work.notify_one();
        Ok(None)
    }

    fn separator(&self) -> Result<Arc<Separator>, String> {
        if let Some(separator) = lock(&self.separator).as_ref() {
            return Ok(separator.clone());
        }
        let separator = Arc::new(Separator::load(&self.directory.join("model.onnx"))?);
        *lock(&self.separator) = Some(separator.clone());
        Ok(separator)
    }
}

/// A file in the encrypted store, readable by the decoder.
struct VaultSource(ambra_vault::Reader<fs::File>);

impl Read for VaultSource {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> { self.0.read(buffer) }
}
impl Seek for VaultSource {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> { self.0.seek(position) }
}
impl MediaSource for VaultSource {
    fn is_seekable(&self) -> bool { true }
    fn byte_len(&self) -> Option<u64> { Some(self.0.len()) }
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/vocal-timing", get(status).put(configure))
        .route("/api/vocal-timing/tracks/{provider}/{track_id}", get(track_curve))
}

pub(super) fn start(state: AppState) {
    if matches!(*lock(&state.vocal_timing.model), Model::Downloading { .. }) {
        tokio::spawn(install(state.clone()));
    }
    tokio::spawn(run(state));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    enabled: bool,
    model: Model,
    model_bytes: u64,
    /// Songs waiting to be analyzed, the running one included.
    pending: usize,
}

async fn status(State(state): State<AppState>) -> Json<Status> {
    let timing = &state.vocal_timing;
    let model = lock(&timing.model).clone();
    Json(Status {
        enabled: !matches!(model, Model::Off),
        model,
        model_bytes: MODEL_BYTES,
        pending: lock(&timing.pending).len(),
    })
}

#[derive(Deserialize)]
struct Configure {
    enabled: bool,
}

async fn configure(State(state): State<AppState>, Json(request): Json<Configure>) -> Result<Json<Status>, ApiError> {
    let timing = &state.vocal_timing;
    let marker = timing.directory.join("enabled");
    if request.enabled {
        fs::create_dir_all(&timing.directory).and_then(|_| fs::write(&marker, b""))
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let mut model = lock(&timing.model);
        if matches!(*model, Model::Off | Model::Failed { .. }) {
            *model = Model::Downloading { received: 0, total: MODEL_BYTES };
            tokio::spawn(install(state.clone()));
        }
    } else {
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_file(timing.directory.join("model.onnx"));
        *lock(&timing.model) = Model::Off;
        *lock(&timing.separator) = None;
        lock(&timing.queue).clear();
        lock(&timing.pending).clear();
        if let Some((_, _, cancel)) = lock(&timing.running).as_ref() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(status(State(state)).await)
}

/// Downloads the model, checked against its pinned hash before it is used.
async fn install(state: AppState) {
    let timing = &state.vocal_timing;
    let path = timing.directory.join("model.onnx");
    let result = async {
        let partial = path.with_extension("part");
        fs::create_dir_all(&timing.directory).map_err(|error| error.to_string())?;
        let mut response = state.download_http_client.get(MODEL_URL).send().await
            .and_then(|response| response.error_for_status())
            .map_err(|error| format!("The vocal model could not be downloaded: {error}"))?;
        let mut file = fs::File::create(&partial).map_err(|error| error.to_string())?;
        let mut received = 0;
        while let Some(chunk) = response.chunk().await.map_err(|error| format!("The vocal model download failed: {error}"))? {
            received += chunk.len() as u64;
            if received > MODEL_BYTES {
                return Err("The vocal model download was larger than expected".to_owned());
            }
            file.write_all(&chunk).map_err(|error| error.to_string())?;
            let mut model = lock(&timing.model);
            if !matches!(*model, Model::Downloading { .. }) {
                // Turned off meanwhile.
                drop(file);
                let _ = fs::remove_file(&partial);
                return Ok(());
            }
            *model = Model::Downloading { received, total: MODEL_BYTES };
        }
        drop(file);
        if !verify_model(&partial) {
            let _ = fs::remove_file(&partial);
            return Err("The downloaded vocal model did not match the expected file".to_owned());
        }
        fs::rename(&partial, &path).map_err(|error| error.to_string())?;
        let mut model = lock(&timing.model);
        if matches!(*model, Model::Downloading { .. }) {
            *model = Model::Ready;
        } else {
            let _ = fs::remove_file(&path);
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        eprintln!("{error}");
        let mut model = lock(&timing.model);
        if matches!(*model, Model::Downloading { .. }) {
            *model = Model::Failed { error };
        }
    }
    timing.work.notify_one();
}

async fn run(state: AppState) {
    let timing = state.vocal_timing.clone();
    loop {
        let mut job = loop {
            if timing.ready()
                && let Some(job) = lock(&timing.queue).pop_front()
            {
                break job;
            }
            timing.work.notified().await;
        };
        let key = job.key();
        let cancel = Arc::new(AtomicBool::new(false));
        *lock(&timing.running) = Some((key.clone(), job.background, cancel.clone()));
        let result = analyze(&state, &mut job, cancel.clone()).await;
        *lock(&timing.running) = None;
        match result {
            Ok(power) => {
                if let Err(error) = timing.save(&key, &power) {
                    eprintln!("Vocal timing for {key} could not be saved: {error}");
                }
                lock(&timing.pending).remove(&key);
            }
            Err(_) if cancel.load(Ordering::Relaxed) => {
                // Gave way to a song playing now, or vocal timing was turned off. It keeps what
                // it finished, and waits at the front of the songs to come.
                if lock(&timing.pending).contains(&key) {
                    let mut queue = lock(&timing.queue);
                    let at = queue.iter().position(|queued| queued.background).unwrap_or(queue.len());
                    queue.insert(at, job);
                }
            }
            Err(error) => {
                eprintln!("Vocal timing for {key} failed: {error}");
                lock(&timing.pending).remove(&key);
                lock(&timing.failed).insert(key, Instant::now());
            }
        }
    }
}

async fn analyze(state: &AppState, job: &mut Job, cancel: Arc<AtomicBool>) -> Result<Vec<f64>, String> {
    let separator = {
        let timing = state.vocal_timing.clone();
        tokio::task::spawn_blocking(move || timing.separator()).await.map_err(|error| error.to_string())??
    };
    let (source, extension, scratch_file): (Box<dyn MediaSource>, Option<String>, Option<String>) =
        if job.provider == "local" {
            let valid = job.track_id.split_once('.').is_some_and(|(hash, extension)| {
                hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit())
                    && (1..=8).contains(&extension.len()) && extension.bytes().all(|c| c.is_ascii_alphanumeric())
            });
            if !valid {
                return Err("Invalid local file".into());
            }
            let path = crate::storage::data_path("local-music").join(&job.track_id);
            let file = fs::File::open(&path).map_err(|error| error.to_string())?;
            (Box::new(file), job.track_id.rsplit('.').next().map(str::to_owned), None)
        } else {
            let scratch = state.vocal_timing.scratch.as_ref().map_err(Clone::clone)?;
            // A job resuming reads the copy it made before, rather than fetching the song again.
            let kept = job.copy.take().and_then(|(file, container)| {
                scratch.open_file(&file).ok().map(|reader| (reader, container, Some(file)))
            });
            let (reader, container, file) = match kept {
                Some(kept) => kept,
                None => downloads::analysis_copy(state, scratch, &job.provider, &job.track_id).await?,
            };
            (Box::new(VaultSource(reader)), Some(container), file)
        };
    let budget = budget(job.background);
    let mut progress = std::mem::take(&mut job.progress);
    let stopped = cancel.clone();
    let container = extension.clone();
    let (result, progress) = tokio::task::spawn_blocking(move || {
        let result = vocal_power(&separator, source, extension.as_deref(), budget, &cancel, &mut progress);
        (result, progress)
    })
    .await
    .map_err(|error| error.to_string())?;
    job.progress = progress;
    if let (Some(file), Ok(scratch)) = (scratch_file, state.vocal_timing.scratch.as_ref()) {
        if result.is_err() && stopped.load(Ordering::Relaxed) {
            job.copy = container.map(|container| (file, container));
        } else {
            let _ = fs::remove_file(scratch.path(&file));
        }
    }
    result
}

/// Separation is heavy and never urgent enough to take over the machine, so it runs at the
/// lowest priority, in efficiency mode (`crate::vocal_timing`), on a few cores. The song playing
/// now gets a quarter of them, at most six; songs coming up have the songs before them to
/// finish in, so they get one or two. Each chunk in flight holds the model's activations (about
/// 250 MB), so there is one per 4 GB installed; with fewer chunks than threads, each chunk is
/// split across threads instead.
fn budget(background: bool) -> Budget {
    let cores = std::thread::available_parallelism().map_or(1, |cores| cores.get());
    let threads = if background { (cores / 8).clamp(1, 2) } else { (cores / 4).clamp(2, 6) };
    let chunks = crate::vocal_timing::installed_memory().map_or(1, |bytes| (bytes >> 32) as usize);
    Budget { threads, chunks: chunks.clamp(1, threads) }
}

/// The vocal curve for the app's own auto-sync: little-endian f32 power per
/// `ambra_lyric_sync::FRAME_MS` frame. 202 while it is being measured.
async fn track_curve(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let background = query.get("prefetch").is_some_and(|value| value == "true");
    match state.vocal_timing.curve(&provider, &track_id, background) {
        Ok(Some(curve)) => {
            let bytes: Vec<u8> = curve.iter().flat_map(|value| (*value as f32).to_le_bytes()).collect();
            ([(CONTENT_TYPE, "application/octet-stream")], bytes).into_response()
        }
        Ok(None) => StatusCode::ACCEPTED.into_response(),
        Err(()) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Places line endings from the song's vocals when they have been measured, and starts
/// measuring them when they haven't.
pub(super) fn apply(state: &AppState, request: &crate::lyrics::LyricsRequest, lyrics: &mut crate::lyrics::LyricsResponse) {
    let (Some(provider), Some(track_id)) = (request.provider.as_deref(), request.track_id.as_deref()) else { return };
    if lyrics.status != "lyrics" || lyrics.sync == "none" {
        return;
    }
    let valid = provider == "local" || (track_id.len() <= 200 && !track_id.contains('/'));
    if !valid {
        return;
    }
    match state.vocal_timing.curve(provider, track_id, request.prefetch) {
        Ok(Some(curve)) => {
            if crate::lyrics::refine_with_vocals(lyrics, &curve) {
                lyrics.vocal_timing = Some("aligned");
            }
        }
        Ok(None) => lyrics.vocal_timing = Some("pending"),
        Err(()) => {}
    }
}

