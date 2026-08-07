use std::{
    collections::HashSet,
    io,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    body::Body,
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{
            ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
        },
    },
    response::Response,
};
use futures_util::{StreamExt, TryStreamExt, stream};
use serde::{Deserialize, Serialize};
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom},
    sync::Mutex,
};

use crate::models::MusicProvider;

const FILE_CHUNK_SIZE: usize = 64 * 1024;
const MAX_UPCOMING_TRACKS: usize = 3;

pub type CacheResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheTrack {
    pub provider: MusicProvider,
    pub provider_track_id: String,
    pub duration_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachePlan {
    #[serde(default)]
    pub revision: u64,
    pub current: Option<CacheTrack>,
    #[serde(default)]
    pub upcoming: Vec<CacheTrack>,
}

impl CachePlan {
    pub fn normalize(mut self) -> Result<Self, &'static str> {
        self.upcoming.truncate(MAX_UPCOMING_TRACKS);
        let mut seen = self
            .current
            .iter()
            .map(|track| (track.provider, track.provider_track_id.clone()))
            .collect::<HashSet<_>>();
        self.upcoming
            .retain(|track| seen.insert((track.provider, track.provider_track_id.clone())));
        if self
            .current
            .iter()
            .chain(self.upcoming.iter())
            .any(|track| {
                !matches!(track.provider, MusicProvider::Tidal | MusicProvider::Qobuz)
                    || !valid_track_id(&track.provider_track_id)
                    || track.duration_seconds == 0
            })
        {
            return Err(
                "Cache tracks must use Tidal or Qobuz, have a safe track ID, and have a positive duration",
            );
        }
        Ok(self)
    }

    fn keys(&self) -> HashSet<TrackKey> {
        self.current
            .iter()
            .chain(self.upcoming.iter())
            .map(TrackKey::from)
            .collect()
    }
}

#[derive(Clone)]
pub struct PlaybackCache {
    root: Arc<PathBuf>,
    plan_state: Arc<Mutex<PlanState>>,
}

struct PlanState {
    generation: u64,
    revision: u64,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct TrackKey {
    provider: &'static str,
    track_id: String,
}

impl From<&CacheTrack> for TrackKey {
    fn from(track: &CacheTrack) -> Self {
        Self {
            provider: provider_slug(track.provider),
            track_id: track.provider_track_id.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct DirectCacheSource {
    pub url: String,
    pub mime_type: String,
}

#[derive(Clone, Debug)]
pub struct DashCacheSource {
    pub initialization_url: String,
    pub media_url_template: String,
    pub timescale: u32,
    pub segment_duration: u32,
    pub start_number: u32,
    pub segment_count: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectMetadata {
    mime_type: String,
    total_size: u64,
    cached_size: u64,
    complete: bool,
}

impl PlaybackCache {
    pub async fn initialize() -> io::Result<Self> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".playback-cache");
        match fs::remove_dir_all(&root).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        fs::create_dir_all(&root).await?;
        Ok(Self {
            root: Arc::new(root),
            plan_state: Arc::new(Mutex::new(PlanState {
                generation: 0,
                revision: 0,
            })),
        })
    }

    pub async fn update_plan(&self, plan: &CachePlan) -> io::Result<Option<u64>> {
        let mut state = self.plan_state.lock().await;
        if plan.revision <= state.revision {
            return Ok(None);
        }
        state.revision = plan.revision;
        state.generation = state.generation.wrapping_add(1);
        self.evict_except(&plan.keys()).await?;
        Ok(Some(state.generation))
    }

    pub async fn is_current_generation(&self, generation: u64) -> bool {
        self.plan_state.lock().await.generation == generation
    }

    pub async fn cache_direct(
        &self,
        track: CacheTrack,
        source: DirectCacheSource,
        full: bool,
        prefetch_seconds: u64,
        trim_to_prefix: bool,
        generation: u64,
        client: reqwest::Client,
    ) -> CacheResult<()> {
        let key = TrackKey::from(&track);
        let directory = self.track_directory(&key);
        fs::create_dir_all(&directory).await?;
        let existing = match fs::read(directory.join("direct.json")).await {
            Ok(bytes) => serde_json::from_slice::<DirectMetadata>(&bytes).ok(),
            Err(_) => None,
        };
        let mut resumable_prefix = None;
        if let Some(existing) = existing {
            if existing.complete && full {
                return Ok(());
            }
            if full {
                resumable_prefix = Some(existing);
            } else {
                let wanted_size = direct_prefetch_size(
                    existing.total_size,
                    track.duration_seconds,
                    prefetch_seconds,
                );
                if existing.complete && !trim_to_prefix
                    || !existing.complete
                        && existing.cached_size >= wanted_size
                        && (!trim_to_prefix || existing.cached_size == wanted_size)
                {
                    return Ok(());
                }

                if existing.complete || existing.cached_size >= wanted_size {
                    let source_name = if existing.complete {
                        "full.data"
                    } else {
                        "prefix.data"
                    };
                    let temporary = directory.join(format!("prefix.{generation}.tmp"));
                    copy_file_prefix(directory.join(source_name), &temporary, wanted_size).await?;
                    let metadata = DirectMetadata {
                        mime_type: existing.mime_type,
                        total_size: existing.total_size,
                        cached_size: wanted_size,
                        complete: false,
                    };
                    self.publish_direct(
                        &directory,
                        &temporary,
                        metadata,
                        generation,
                        "prefix.data",
                    )
                    .await?;
                    return Ok(());
                }
            }
        }

        if full {
            let temporary = directory.join(format!("full.{generation}.tmp"));
            let (size, expected_size) = if let Some(existing) = resumable_prefix {
                copy_file_prefix(
                    directory.join("prefix.data"),
                    &temporary,
                    existing.cached_size,
                )
                .await?;
                let response = client
                    .get(&source.url)
                    .header(RANGE, format!("bytes={}-", existing.cached_size))
                    .send()
                    .await?;
                let can_resume = response.status() == StatusCode::PARTIAL_CONTENT
                    && content_range_starts_at(response.headers(), existing.cached_size);
                if can_resume {
                    let appended = append_response(response, &temporary).await?;
                    (
                        existing.cached_size.saturating_add(appended),
                        existing.total_size,
                    )
                } else {
                    remove_if_exists(&temporary).await;
                    let response = checked_response(client.get(&source.url).send().await?).await?;
                    let expected = response.content_length();
                    let size = stream_response(response, &temporary).await?;
                    (size, expected.unwrap_or(size))
                }
            } else {
                let response = checked_response(client.get(&source.url).send().await?).await?;
                let expected = response.content_length();
                let size = stream_response(response, &temporary).await?;
                (size, expected.unwrap_or(size))
            };
            if expected_size != size {
                remove_if_exists(&temporary).await;
                return Err(
                    io::Error::other("Direct download ended before its declared length").into(),
                );
            }
            let metadata = DirectMetadata {
                mime_type: source.mime_type,
                total_size: size,
                cached_size: size,
                complete: true,
            };
            self.publish_direct(&directory, &temporary, metadata, generation, "full.data")
                .await?;
        } else {
            let total_size = discover_total_size(&client, &source.url).await?;
            let cached_size =
                direct_prefetch_size(total_size, track.duration_seconds, prefetch_seconds);
            let end = cached_size.saturating_sub(1);
            let response = checked_response(
                client
                    .get(&source.url)
                    .header(RANGE, format!("bytes=0-{end}"))
                    .send()
                    .await?,
            )
            .await?;
            let temporary = directory.join(format!("prefix.{generation}.tmp"));
            let actual_size = stream_response_limited(response, &temporary, cached_size).await?;
            let metadata = DirectMetadata {
                mime_type: source.mime_type,
                total_size,
                cached_size: actual_size.min(total_size),
                complete: actual_size >= total_size,
            };
            let destination = if metadata.complete {
                "full.data"
            } else {
                "prefix.data"
            };
            self.publish_direct(&directory, &temporary, metadata, generation, destination)
                .await?;
        }
        Ok(())
    }

    pub async fn cache_dash(
        &self,
        track: CacheTrack,
        source: DashCacheSource,
        full: bool,
        prefetch_seconds: u64,
        trim_to_prefix: bool,
        generation: u64,
        client: reqwest::Client,
    ) -> CacheResult<()> {
        let key = TrackKey::from(&track);
        let directory = self.track_directory(&key);
        fs::create_dir_all(&directory).await?;

        let init = self.download_to_cache(
            client.clone(),
            source.initialization_url,
            directory.join("init.data"),
            generation,
        );
        let available_count = source.segment_count.unwrap_or_else(|| {
            segment_count_for_duration(
                track.duration_seconds,
                source.timescale,
                source.segment_duration,
            )
        });
        let wanted_count = if full {
            available_count
        } else {
            prefetch_segment_count(
                prefetch_seconds,
                source.timescale,
                source.segment_duration,
                available_count,
            )
        };
        let cache = self.clone();
        let template = source.media_url_template;
        let directory_for_segments = directory.clone();
        let segments = stream::iter(0..wanted_count)
            .map(|offset| {
                let cache = cache.clone();
                let client = client.clone();
                let template = template.clone();
                let directory = directory_for_segments.clone();
                async move {
                    let number = source.start_number.saturating_add(offset);
                    cache
                        .download_to_cache(
                            client,
                            template.replace("$Number$", &number.to_string()),
                            directory.join(format!("segment-{number}.data")),
                            generation,
                        )
                        .await
                }
            })
            .buffer_unordered(4)
            .try_collect::<Vec<_>>();
        let (_, _) = tokio::try_join!(init, segments)?;
        if !full && trim_to_prefix {
            let current = self.plan_state.lock().await;
            if current.generation == generation {
                self.remove_dash_segments_after(&directory, source.start_number, wanted_count)
                    .await?;
            }
        }
        Ok(())
    }

    pub async fn direct_response(
        &self,
        provider: &str,
        track_id: &str,
        headers: &HeaderMap,
    ) -> Option<Result<Response, io::Error>> {
        if !matches!(provider, "tidal" | "qobuz") || !valid_track_id(track_id) {
            return None;
        }
        let directory = self.root.join(provider).join(track_id);
        let metadata: DirectMetadata =
            serde_json::from_slice(&fs::read(directory.join("direct.json")).await.ok()?).ok()?;
        if !metadata.complete {
            let Some(range) = headers.get(RANGE) else {
                return None;
            };
            match range
                .to_str()
                .map_err(|_| ())
                .and_then(|value| parse_byte_range(value, metadata.total_size))
            {
                Ok(Some((start, end)))
                    if start >= metadata.cached_size || end >= metadata.cached_size =>
                {
                    return None;
                }
                Ok(Some(_)) | Ok(None) | Err(()) => {}
            }
        }
        let path = if metadata.complete {
            directory.join("full.data")
        } else {
            directory.join("prefix.data")
        };
        if !path.is_file() {
            return None;
        }

        match serve_direct_file(path, metadata, headers).await {
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            response => Some(response),
        }
    }

    pub async fn dash_response(
        &self,
        track_id: &str,
        segment: Option<u32>,
        mime_type: &str,
    ) -> Option<Result<Response, io::Error>> {
        if !valid_track_id(track_id) {
            return None;
        }
        let name = segment
            .map(|number| format!("segment-{number}.data"))
            .unwrap_or_else(|| "init.data".to_owned());
        let path = self.root.join("tidal").join(track_id).join(name);
        if !path.is_file() {
            return None;
        }
        match serve_whole_file(path, mime_type).await {
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            response => Some(response),
        }
    }

    async fn publish_direct(
        &self,
        directory: &Path,
        temporary: &Path,
        metadata: DirectMetadata,
        generation: u64,
        destination_name: &str,
    ) -> CacheResult<()> {
        let metadata_temporary = directory.join(format!("direct.{generation}.tmp"));
        fs::write(&metadata_temporary, serde_json::to_vec(&metadata)?).await?;
        let current = self.plan_state.lock().await;
        if current.generation != generation {
            drop(current);
            remove_if_exists(temporary).await;
            remove_if_exists(&metadata_temporary).await;
            return Ok(());
        }
        fs::rename(temporary, directory.join(destination_name)).await?;
        fs::rename(metadata_temporary, directory.join("direct.json")).await?;
        let obsolete_name = if destination_name == "full.data" {
            "prefix.data"
        } else {
            "full.data"
        };
        remove_if_exists(&directory.join(obsolete_name)).await;
        Ok(())
    }

    async fn download_to_cache(
        &self,
        client: reqwest::Client,
        url: String,
        destination: PathBuf,
        generation: u64,
    ) -> CacheResult<()> {
        if destination.is_file() {
            return Ok(());
        }
        let temporary = destination.with_extension(format!("{generation}.tmp"));
        let response = checked_response(client.get(url).send().await?).await?;
        stream_response(response, &temporary).await?;
        let current = self.plan_state.lock().await;
        if current.generation != generation {
            drop(current);
            remove_if_exists(&temporary).await;
            return Ok(());
        }
        fs::rename(temporary, destination).await?;
        Ok(())
    }

    async fn remove_dash_segments_after(
        &self,
        directory: &Path,
        start_number: u32,
        retained_count: u32,
    ) -> io::Result<()> {
        let retained_end = start_number.saturating_add(retained_count);
        let mut entries = fs::read_dir(directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(number) = name
                .strip_prefix("segment-")
                .and_then(|value| value.strip_suffix(".data"))
                .and_then(|value| value.parse::<u32>().ok())
            else {
                continue;
            };
            if number < start_number || number >= retained_end {
                remove_if_exists(&entry.path()).await;
            }
        }
        Ok(())
    }

    async fn evict_except(&self, retained: &HashSet<TrackKey>) -> io::Result<()> {
        for provider in ["tidal", "qobuz"] {
            let provider_directory = self.root.join(provider);
            let mut entries = match fs::read_dir(&provider_directory).await {
                Ok(entries) => entries,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            while let Some(entry) = entries.next_entry().await? {
                let track_id = entry.file_name().to_string_lossy().into_owned();
                let key = TrackKey { provider, track_id };
                if !retained.contains(&key) {
                    fs::remove_dir_all(entry.path()).await?;
                }
            }
        }
        Ok(())
    }

    fn track_directory(&self, key: &TrackKey) -> PathBuf {
        self.root.join(key.provider).join(&key.track_id)
    }
}

async fn checked_response(response: reqwest::Response) -> CacheResult<reqwest::Response> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(io::Error::other(format!(
            "Playback cache upstream returned HTTP {}",
            response.status()
        ))
        .into())
    }
}

async fn discover_total_size(client: &reqwest::Client, url: &str) -> CacheResult<u64> {
    let head = client.head(url).send().await?;
    if head.status().is_success()
        && let Some(size) = head.content_length()
        && size > 0
    {
        return Ok(size);
    }

    let probe = client.get(url).header(RANGE, "bytes=0-0").send().await?;
    if !probe.status().is_success() {
        return Err(io::Error::other(format!(
            "Playback size probe returned HTTP {}",
            probe.status()
        ))
        .into());
    }
    probe
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range_total)
        .or_else(|| probe.content_length())
        .filter(|size| *size > 0)
        .ok_or_else(|| io::Error::other("Playback source did not report its total size").into())
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    value.rsplit_once('/')?.1.parse().ok()
}

fn content_range_starts_at(headers: &HeaderMap, expected_start: u64) -> bool {
    headers
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes "))
        .and_then(|value| value.split_once('-'))
        .and_then(|(start, _)| start.parse::<u64>().ok())
        == Some(expected_start)
}

async fn stream_response(response: reqwest::Response, path: &Path) -> CacheResult<u64> {
    stream_response_limited(response, path, u64::MAX).await
}

async fn append_response(response: reqwest::Response, path: &Path) -> CacheResult<u64> {
    let mut file = OpenOptions::new().append(true).open(path).await?;
    let mut size = 0_u64;
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        size = size.saturating_add(chunk.len() as u64);
    }
    file.flush().await?;
    Ok(size)
}

async fn stream_response_limited(
    response: reqwest::Response,
    path: &Path,
    limit: u64,
) -> CacheResult<u64> {
    let mut file = File::create(path).await?;
    let mut size = 0_u64;
    let mut body = response.bytes_stream();
    while size < limit
        && let Some(chunk) = body.next().await
    {
        let chunk = chunk?;
        let remaining = (limit - size) as usize;
        let bytes = &chunk[..chunk.len().min(remaining)];
        file.write_all(bytes).await?;
        size = size.saturating_add(bytes.len() as u64);
    }
    file.flush().await?;
    Ok(size)
}

async fn copy_file_prefix(source: PathBuf, destination: &Path, length: u64) -> CacheResult<()> {
    let mut source = File::open(source).await?.take(length);
    let mut destination = File::create(destination).await?;
    let copied = tokio::io::copy(&mut source, &mut destination).await?;
    if copied != length {
        return Err(
            io::Error::new(io::ErrorKind::UnexpectedEof, "Cached track ended early").into(),
        );
    }
    destination.flush().await?;
    Ok(())
}

async fn serve_direct_file(
    path: PathBuf,
    metadata: DirectMetadata,
    headers: &HeaderMap,
) -> Result<Response, io::Error> {
    let requested = match headers.get(RANGE) {
        Some(value) => match value
            .to_str()
            .ok()
            .and_then(|value| parse_byte_range(value, metadata.total_size).ok())
            .flatten()
        {
            Some(range) => Some(range),
            None => return range_not_satisfiable(metadata.total_size),
        },
        None => None,
    };

    if requested.is_none() && !metadata.complete {
        return range_not_satisfiable(metadata.total_size);
    }
    let (start, requested_end) = requested.unwrap_or((0, metadata.total_size.saturating_sub(1)));
    if start >= metadata.cached_size {
        return range_not_satisfiable(metadata.total_size);
    }
    let end = requested_end.min(metadata.cached_size.saturating_sub(1));
    let length = end - start + 1;
    let mut file = File::open(path).await?;
    file.seek(SeekFrom::Start(start)).await?;
    let body = file_body(file, length);
    let mut builder = Response::builder()
        .status(if requested.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(CONTENT_TYPE, metadata.mime_type)
        .header(CONTENT_LENGTH, length)
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, "no-store");
    if requested.is_some() {
        builder = builder.header(
            CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", metadata.total_size),
        );
    }
    builder.body(body).map_err(io::Error::other)
}

async fn serve_whole_file(path: PathBuf, mime_type: &str) -> Result<Response, io::Error> {
    let file = File::open(path).await?;
    let length = file.metadata().await?.len();
    Response::builder()
        .status(StatusCode::OK)
        .header(
            CONTENT_TYPE,
            HeaderValue::from_str(mime_type).map_err(io::Error::other)?,
        )
        .header(CONTENT_LENGTH, length)
        .header(CACHE_CONTROL, "no-store")
        .body(file_body(file, length))
        .map_err(io::Error::other)
}

fn file_body(file: File, length: u64) -> Body {
    let body = stream::try_unfold((file, length), |(mut file, remaining)| async move {
        if remaining == 0 {
            return Ok(None);
        }
        let mut buffer = vec![0; FILE_CHUNK_SIZE.min(remaining as usize)];
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Cached file ended early",
            ));
        }
        buffer.truncate(read);
        Ok(Some((buffer, (file, remaining - read as u64))))
    });
    Body::from_stream(body)
}

fn range_not_satisfiable(total_size: u64) -> Result<Response, io::Error> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(CONTENT_RANGE, format!("bytes */{total_size}"))
        .body(Body::empty())
        .map_err(io::Error::other)
}

fn parse_byte_range(value: &str, total_size: u64) -> Result<Option<(u64, u64)>, ()> {
    let range = value.strip_prefix("bytes=").ok_or(())?;
    if range.contains(',') || total_size == 0 {
        return Err(());
    }
    let (start, end) = range.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix: u64 = end.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = total_size.saturating_sub(suffix);
        return Ok(Some((start, total_size - 1)));
    }
    let start: u64 = start.parse().map_err(|_| ())?;
    if start >= total_size {
        return Ok(None);
    }
    let end = if end.is_empty() {
        total_size - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(total_size - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn direct_prefetch_size(total_size: u64, duration_seconds: u64, prefetch_seconds: u64) -> u64 {
    total_size
        .saturating_mul(prefetch_seconds)
        .div_ceil(duration_seconds.max(1))
        .clamp(1, total_size)
}

fn prefetch_segment_count(
    prefetch_seconds: u64,
    timescale: u32,
    segment_duration: u32,
    available: u32,
) -> u32 {
    if timescale == 0 || segment_duration == 0 {
        return 0;
    }
    let wanted_units = u64::from(timescale) * prefetch_seconds;
    wanted_units
        .div_ceil(u64::from(segment_duration))
        .min(u64::from(available)) as u32
}

fn segment_count_for_duration(duration_seconds: u64, timescale: u32, segment_duration: u32) -> u32 {
    if timescale == 0 || segment_duration == 0 {
        return 0;
    }
    duration_seconds
        .saturating_mul(u64::from(timescale))
        .div_ceil(u64::from(segment_duration))
        .min(u64::from(u32::MAX)) as u32
}

fn provider_slug(provider: MusicProvider) -> &'static str {
    match provider {
        MusicProvider::Tidal => "tidal",
        MusicProvider::Qobuz => "qobuz",
        MusicProvider::Spotify => "spotify",
        MusicProvider::YoutubeMusic => "youtubeMusic",
    }
}

fn valid_track_id(track_id: &str) -> bool {
    !track_id.is_empty()
        && track_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

async fn remove_if_exists(path: &Path) {
    if let Err(error) = fs::remove_file(path).await
        && error.kind() != io::ErrorKind::NotFound
    {
        eprintln!(
            "Could not remove obsolete playback cache file {}: {error}",
            path.display()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CachePlan, CacheTrack, direct_prefetch_size, parse_byte_range, prefetch_segment_count,
    };
    use crate::models::MusicProvider;

    fn track(id: &str) -> CacheTrack {
        CacheTrack {
            provider: MusicProvider::Tidal,
            provider_track_id: id.to_owned(),
            duration_seconds: 180,
        }
    }

    #[test]
    fn truncates_plan_to_three_upcoming_tracks() {
        let plan = CachePlan {
            revision: 1,
            current: Some(track("current")),
            upcoming: (0..7).map(|index| track(&index.to_string())).collect(),
        }
        .normalize()
        .unwrap();

        assert_eq!(plan.upcoming.len(), 3);
        assert_eq!(plan.upcoming[2].provider_track_id, "2");
    }

    #[test]
    fn parses_single_byte_ranges() {
        assert_eq!(parse_byte_range("bytes=2-5", 10), Ok(Some((2, 5))));
        assert_eq!(parse_byte_range("bytes=7-", 10), Ok(Some((7, 9))));
        assert_eq!(parse_byte_range("bytes=-3", 10), Ok(Some((7, 9))));
        assert_eq!(parse_byte_range("bytes=10-", 10), Ok(None));
        assert!(parse_byte_range("bytes=1-2,4-5", 10).is_err());
    }

    #[test]
    fn sizes_direct_prefixes_for_each_cache_stage() {
        assert_eq!(direct_prefetch_size(180_000, 180, 10), 10_000);
        assert_eq!(direct_prefetch_size(180_000, 180, 5), 5_000);
    }

    #[test]
    fn chooses_enough_dash_segments_for_each_cache_stage() {
        assert_eq!(prefetch_segment_count(10, 1_000, 4_000, 20), 3);
        assert_eq!(prefetch_segment_count(5, 44_100, 176_400, 2), 2);
        assert_eq!(prefetch_segment_count(10, 0, 4_000, 20), 0);
    }
}
