use std::{collections::HashSet, env, fs, io, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{
        HeaderMap, HeaderValue, Method, StatusCode,
        header::{
            ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG,
            LAST_MODIFIED, RANGE,
        },
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{StreamExt, TryStreamExt, stream};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use crate::{
    models::{HealthResponse, LibraryResponse, MusicProvider, TrackMetadata},
    playback_cache::{CachePlan, CacheTrack, DashCacheSource, DirectCacheSource, PlaybackCache},
    providers::qobuz::QobuzProvider,
    providers::tidal::{PlaybackSource, TidalProvider},
};

const DEFAULT_ADDRESS: &str = "127.0.0.1:8787";
const DEFAULT_TIDAL_TRACK_ID: &str = "3756725";
const CURRENT_INITIAL_CACHE_SECONDS: u64 = 10;
const UPCOMING_CACHE_SECONDS: u64 = 5;

type ServerResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone)]
struct AppState {
    tidal: TidalProvider,
    qobuz: Option<QobuzProvider>,
    http_client: reqwest::Client,
    library_entries: Arc<RwLock<Vec<LibraryEntry>>>,
    playback_cache: PlaybackCache,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryEntry {
    provider: MusicProvider,
    provider_track_id: String,
}

pub async fn serve() -> ServerResult<()> {
    let playback_cache = PlaybackCache::initialize().await?;
    let qobuz = match QobuzProvider::authenticate_if_configured().await {
        Ok(provider) => provider,
        Err(error) => {
            eprintln!("Qobuz disabled because login failed: {error}");
            None
        }
    };
    let state = AppState {
        tidal: TidalProvider::authenticate().await?,
        qobuz,
        http_client: reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()?,
        library_entries: Arc::new(RwLock::new(initial_library_entries())),
        playback_cache,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::HEAD, Method::POST])
        .allow_headers([RANGE, CONTENT_TYPE])
        .expose_headers([CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES, CONTENT_TYPE])
        .allow_private_network(true);

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/library", get(library))
        .route("/api/playback/cache-plan", post(update_cache_plan))
        .route("/api/library/albums", post(add_album))
        .route("/api/library/tidal-albums", post(add_tidal_album))
        .route("/api/library/qobuz-albums", post(add_qobuz_album))
        .route(
            "/api/providers/{provider}/tracks/{track_id}/stream",
            get(stream_track),
        )
        .route(
            "/api/providers/{provider}/tracks/{track_id}/manifest.mpd",
            get(dash_manifest),
        )
        .route(
            "/api/providers/{provider}/tracks/{track_id}/playlist.m3u8",
            get(hls_manifest),
        )
        .route(
            "/api/providers/{provider}/tracks/{track_id}/dash/init",
            get(dash_initialization),
        )
        .route(
            "/api/providers/{provider}/tracks/{track_id}/dash/{segment_number}",
            get(dash_segment),
        )
        .layer(cors)
        .with_state(state);

    let address = env::var("AMBRA_SERVER_ADDRESS").unwrap_or_else(|_| DEFAULT_ADDRESS.to_owned());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("Ambra server listening on http://{address}");

    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn update_cache_plan(
    State(state): State<AppState>,
    Json(plan): Json<CachePlan>,
) -> Result<(StatusCode, Json<CachePlan>), ApiError> {
    let plan = plan.normalize().map_err(ApiError::bad_request)?;
    let Some(generation) = state
        .playback_cache
        .update_plan(&plan)
        .await
        .map_err(ApiError::internal)?
    else {
        return Ok((StatusCode::ACCEPTED, Json(plan)));
    };

    spawn_cache_plan(state, plan.clone(), generation);

    Ok((StatusCode::ACCEPTED, Json(plan)))
}

fn spawn_cache_plan(state: AppState, plan: CachePlan, generation: u64) {
    tokio::spawn(async move {
        let current = plan.current;
        if let Some(track) = current.clone() {
            cache_stage(
                &state,
                track,
                false,
                CURRENT_INITIAL_CACHE_SECONDS,
                false,
                generation,
            )
            .await;
        }

        if !state.playback_cache.is_current_generation(generation).await {
            return;
        }
        for track in plan.upcoming {
            cache_stage(
                &state,
                track,
                false,
                UPCOMING_CACHE_SECONDS,
                true,
                generation,
            )
            .await;
            if !state.playback_cache.is_current_generation(generation).await {
                return;
            }
        }

        if let Some(track) = current {
            cache_stage(&state, track, true, 0, false, generation).await;
        }
    });
}

async fn cache_stage(
    state: &AppState,
    track: CacheTrack,
    full: bool,
    prefetch_seconds: u64,
    trim_to_prefix: bool,
    generation: u64,
) {
    let label = format!(
        "{}:{}",
        provider_name(track.provider),
        track.provider_track_id
    );
    if let Err(error) = cache_track(
        state,
        track,
        full,
        prefetch_seconds,
        trim_to_prefix,
        generation,
    )
    .await
    {
        eprintln!("Could not cache playback for {label}: {error}");
    }
}

async fn cache_track(
    state: &AppState,
    track: CacheTrack,
    full: bool,
    prefetch_seconds: u64,
    trim_to_prefix: bool,
    generation: u64,
) -> ServerResult<()> {
    match track.provider {
        MusicProvider::Tidal => match state
            .tidal
            .playback_source(&track.provider_track_id)
            .await?
        {
            PlaybackSource::Direct { url, mime_type, .. } => {
                state
                    .playback_cache
                    .cache_direct(
                        track,
                        DirectCacheSource { url, mime_type },
                        full,
                        prefetch_seconds,
                        trim_to_prefix,
                        generation,
                        state.http_client.clone(),
                    )
                    .await?;
            }
            PlaybackSource::Dash {
                initialization_url,
                media_url_template,
                timescale,
                segment_duration,
                start_number,
                segment_count,
                ..
            } => {
                state
                    .playback_cache
                    .cache_dash(
                        track,
                        DashCacheSource {
                            initialization_url,
                            media_url_template,
                            timescale,
                            segment_duration,
                            start_number,
                            segment_count,
                        },
                        full,
                        prefetch_seconds,
                        trim_to_prefix,
                        generation,
                        state.http_client.clone(),
                    )
                    .await?;
            }
        },
        MusicProvider::Qobuz => {
            let source = state
                .qobuz
                .as_ref()
                .ok_or_else(|| io::Error::other("Qobuz login is not configured"))?
                .playback_source(&track.provider_track_id)
                .await?;
            state
                .playback_cache
                .cache_direct(
                    track,
                    DirectCacheSource {
                        url: source.url,
                        mime_type: source.mime_type,
                    },
                    full,
                    prefetch_seconds,
                    trim_to_prefix,
                    generation,
                    state.http_client.clone(),
                )
                .await?;
        }
        _ => return Err(io::Error::other("Unsupported cache provider").into()),
    }
    Ok(())
}

async fn library(State(state): State<AppState>) -> Result<Json<LibraryResponse>, ApiError> {
    let entries = state.library_entries.read().await.clone();
    let available_entries = entries
        .into_iter()
        .filter(|entry| entry.provider != MusicProvider::Qobuz || state.qobuz.is_some())
        .collect::<Vec<_>>();
    let tracks = load_tracks(&state, &available_entries).await?;

    Ok(Json(LibraryResponse { tracks }))
}

#[derive(Deserialize)]
struct AddAlbumRequest {
    url: String,
}

async fn add_album(
    State(state): State<AppState>,
    Json(request): Json<AddAlbumRequest>,
) -> Result<Json<LibraryResponse>, ApiError> {
    if let Some(album_id) = tidal_album_id(&request.url) {
        return import_album(&state, MusicProvider::Tidal, album_id).await;
    }
    if let Some(album_id) = qobuz_album_id(&request.url) {
        return import_album(&state, MusicProvider::Qobuz, album_id).await;
    }
    Err(ApiError::bad_request(
        "Unsupported album link; paste a Tidal or Qobuz album URL",
    ))
}

async fn add_tidal_album(
    State(state): State<AppState>,
    Json(request): Json<AddAlbumRequest>,
) -> Result<Json<LibraryResponse>, ApiError> {
    let album_id = tidal_album_id(&request.url)
        .ok_or_else(|| ApiError::bad_request("Invalid Tidal album link"))?;
    import_album(&state, MusicProvider::Tidal, album_id).await
}

async fn add_qobuz_album(
    State(state): State<AppState>,
    Json(request): Json<AddAlbumRequest>,
) -> Result<Json<LibraryResponse>, ApiError> {
    let album_id = qobuz_album_id(&request.url)
        .ok_or_else(|| ApiError::bad_request("Invalid Qobuz album link"))?;
    import_album(&state, MusicProvider::Qobuz, album_id).await
}

async fn import_album(
    state: &AppState,
    provider: MusicProvider,
    album_id: String,
) -> Result<Json<LibraryResponse>, ApiError> {
    let track_ids = match provider {
        MusicProvider::Tidal => state
            .tidal
            .album_track_ids(&album_id)
            .await
            .map_err(ApiError::upstream)?,
        MusicProvider::Qobuz => qobuz_provider(state)?
            .album_track_ids(&album_id)
            .await
            .map_err(ApiError::upstream)?,
        _ => return Err(ApiError::bad_request("Music provider is not implemented")),
    };

    if track_ids.is_empty() {
        return Err(ApiError::not_found(format!(
            "{} album {album_id} contains no tracks",
            provider_name(provider)
        )));
    }

    let entries = track_ids
        .into_iter()
        .map(|provider_track_id| LibraryEntry {
            provider,
            provider_track_id,
        })
        .collect::<Vec<_>>();
    let tracks = load_tracks(state, &entries).await?;

    let mut library_entries = state.library_entries.write().await;
    move_entries_to_end(&mut library_entries, entries);
    if let Err(error) = save_library_entries(&library_entries) {
        eprintln!("Could not persist the streaming library cache: {error}");
    }

    Ok(Json(LibraryResponse { tracks }))
}

async fn load_tracks(
    state: &AppState,
    entries: &[LibraryEntry],
) -> Result<Vec<TrackMetadata>, ApiError> {
    stream::iter(entries.iter().cloned())
        .map(|entry| {
            let state = state.clone();
            async move { load_track(&state, &entry).await }
        })
        .buffered(4)
        .map_err(ApiError::upstream)
        .try_collect()
        .await
}

async fn load_track(state: &AppState, entry: &LibraryEntry) -> ServerResult<TrackMetadata> {
    match entry.provider {
        MusicProvider::Tidal => state.tidal.track_metadata(&entry.provider_track_id).await,
        MusicProvider::Qobuz => {
            state
                .qobuz
                .as_ref()
                .ok_or_else(|| io::Error::other("Qobuz login is not configured"))?
                .track_metadata(&entry.provider_track_id)
                .await
        }
        _ => Err(io::Error::other("Music provider is not implemented").into()),
    }
}

fn move_entries_to_end(library: &mut Vec<LibraryEntry>, ordered_entries: Vec<LibraryEntry>) {
    let incoming_entries = ordered_entries.iter().collect::<HashSet<_>>();
    library.retain(|entry| !incoming_entries.contains(entry));
    library.extend(ordered_entries);
}

fn initial_library_entries() -> Vec<LibraryEntry> {
    let configured = configured_tidal_track_ids()
        .into_iter()
        .map(|provider_track_id| LibraryEntry {
            provider: MusicProvider::Tidal,
            provider_track_id,
        })
        .collect::<Vec<_>>();
    let mut cached = load_library_entries();
    let cached_entries = cached.iter().collect::<HashSet<_>>();
    let missing_configured = configured
        .into_iter()
        .filter(|entry| !cached_entries.contains(entry))
        .collect::<Vec<_>>();
    cached.splice(0..0, missing_configured);
    cached
}

fn library_entries_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".streaming-library.json")
}

fn legacy_library_track_ids_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".library-track-ids.json")
}

fn load_library_entries() -> Vec<LibraryEntry> {
    let path = library_entries_path();
    let encoded = match fs::read(&path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return load_legacy_tidal_entries();
        }
        Err(error) => {
            eprintln!("Could not read streaming library cache: {error}");
            return Vec::new();
        }
    };

    serde_json::from_slice(&encoded).unwrap_or_else(|error| {
        eprintln!("Could not decode streaming library cache: {error}");
        Vec::new()
    })
}

fn load_legacy_tidal_entries() -> Vec<LibraryEntry> {
    fs::read(legacy_library_track_ids_path())
        .ok()
        .and_then(|encoded| serde_json::from_slice::<Vec<String>>(&encoded).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|provider_track_id| LibraryEntry {
            provider: MusicProvider::Tidal,
            provider_track_id,
        })
        .collect()
}

fn save_library_entries(entries: &[LibraryEntry]) -> io::Result<()> {
    let path = library_entries_path();
    let temporary_path = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary_path, serde_json::to_vec(entries)?)?;
    fs::rename(temporary_path, path)
}

fn tidal_album_id(link: &str) -> Option<String> {
    let link = link.trim();
    let without_scheme = link
        .strip_prefix("https://")
        .or_else(|| link.strip_prefix("http://"))?;
    let (host, path) = without_scheme.split_once('/')?;
    let host = host.split(':').next()?.to_ascii_lowercase();
    if !matches!(
        host.as_str(),
        "tidal.com" | "www.tidal.com" | "listen.tidal.com"
    ) {
        return None;
    }

    let clean_path = path.split(['?', '#']).next()?;
    let segments = clean_path.split('/').collect::<Vec<_>>();
    segments
        .windows(2)
        .find(|segments| segments[0] == "album" && !segments[1].is_empty())
        .map(|segments| segments[1])
        .filter(|album_id| album_id.chars().all(|character| character.is_ascii_digit()))
        .map(str::to_owned)
}

fn qobuz_album_id(link: &str) -> Option<String> {
    let link = link.trim();
    let without_scheme = link
        .strip_prefix("https://")
        .or_else(|| link.strip_prefix("http://"))?;
    let (host, path) = without_scheme.split_once('/')?;
    let host = host.split(':').next()?.to_ascii_lowercase();
    if !matches!(
        host.as_str(),
        "qobuz.com" | "www.qobuz.com" | "play.qobuz.com" | "open.qobuz.com"
    ) {
        return None;
    }

    let clean_path = path.split(['?', '#']).next()?;
    let segments = clean_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let album_index = segments.iter().position(|segment| *segment == "album")?;
    let album_id = segments.get(album_index + 1..)?.last()?;
    (!album_id.is_empty()
        && album_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-'))
    .then(|| (*album_id).to_owned())
}

async fn stream_track(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(response) = state
        .playback_cache
        .direct_response(&provider, &track_id, &headers)
        .await
    {
        return response.map_err(ApiError::internal);
    }

    match provider.as_str() {
        "tidal" => {
            let source = state
                .tidal
                .playback_source(&track_id)
                .await
                .map_err(ApiError::upstream)?;
            match source {
                PlaybackSource::Direct { url, mime_type, .. } => {
                    proxy_direct_stream(&state.http_client, &url, &mime_type, &headers).await
                }
                PlaybackSource::Dash { .. } => Err(ApiError::not_found(format!(
                    "Tidal track {track_id} uses its DASH manifest endpoint"
                ))),
            }
        }
        "qobuz" => {
            let source = qobuz_provider(&state)?
                .playback_source(&track_id)
                .await
                .map_err(ApiError::upstream)?;
            proxy_direct_stream(&state.http_client, &source.url, &source.mime_type, &headers).await
        }
        _ => Err(ApiError::not_found(format!(
            "Music provider '{provider}' is not configured"
        ))),
    }
}

async fn dash_manifest(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    ensure_tidal_provider(&provider)?;

    let source = state
        .tidal
        .playback_source(&track_id)
        .await
        .map_err(ApiError::upstream)?;
    let PlaybackSource::Dash {
        mime_type,
        codecs,
        bandwidth,
        timescale,
        segment_duration,
        start_number,
        track_duration_seconds,
        ..
    } = source
    else {
        return Err(ApiError::not_found(format!(
            "Tidal track {track_id} does not use DASH playback"
        )));
    };

    let manifest = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-live:2011" mediaPresentationDuration="PT{track_duration_seconds}S" minBufferTime="PT2S">
  <Period duration="PT{track_duration_seconds}S">
    <AdaptationSet contentType="audio" mimeType="{mime_type}" segmentAlignment="true" startWithSAP="1">
      <Representation id="audio" bandwidth="{}" codecs="{codecs}">
        <SegmentTemplate timescale="{timescale}" duration="{segment_duration}" startNumber="{start_number}" initialization="dash/init" media="dash/$Number$" />
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>"#,
        bandwidth.unwrap_or(320_000)
    );

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/dash+xml")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(manifest))
        .map_err(ApiError::internal)
}

async fn hls_manifest(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    ensure_tidal_provider(&provider)?;

    let source = state
        .tidal
        .playback_source(&track_id)
        .await
        .map_err(ApiError::upstream)?;
    let PlaybackSource::Dash {
        timescale,
        segment_duration,
        start_number,
        segment_count,
        track_duration_seconds,
        ..
    } = source
    else {
        return Err(ApiError::not_found(format!(
            "Tidal track {track_id} does not use segmented playback"
        )));
    };
    let segment_count = segment_count.ok_or_else(|| {
        ApiError::internal(format!("Tidal track {track_id} has no segment count"))
    })?;
    let playlist = hls_playlist_body(
        timescale,
        segment_duration,
        start_number,
        segment_count,
        track_duration_seconds,
    )?;

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/vnd.apple.mpegurl")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(playlist))
        .map_err(ApiError::internal)
}

fn hls_playlist_body(
    timescale: u32,
    segment_duration: u32,
    start_number: u32,
    segment_count: u32,
    track_duration_seconds: u64,
) -> Result<String, ApiError> {
    if timescale == 0 || segment_duration == 0 || segment_count == 0 {
        return Err(ApiError::internal("Invalid segmented audio timing"));
    }

    let nominal_duration = f64::from(segment_duration) / f64::from(timescale);
    let target_duration = nominal_duration.ceil().max(1.0) as u64;
    let mut remaining = track_duration_seconds as f64;
    let mut playlist = format!(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:{target_duration}\n#EXT-X-MEDIA-SEQUENCE:{start_number}\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"dash/init\"\n"
    );

    for offset in 0..segment_count {
        let duration = remaining.min(nominal_duration).max(0.001);
        let segment_number = start_number.saturating_add(offset);
        playlist.push_str(&format!("#EXTINF:{duration:.6},\ndash/{segment_number}\n"));
        remaining = (remaining - nominal_duration).max(0.0);
    }
    playlist.push_str("#EXT-X-ENDLIST\n");
    Ok(playlist)
}

async fn dash_initialization(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    ensure_tidal_provider(&provider)?;
    if let Some(response) = state
        .playback_cache
        .dash_response(&track_id, None, "audio/mp4")
        .await
    {
        return response.map_err(ApiError::internal);
    }

    let source = state
        .tidal
        .playback_source(&track_id)
        .await
        .map_err(ApiError::upstream)?;
    let PlaybackSource::Dash {
        initialization_url,
        mime_type,
        ..
    } = source
    else {
        return Err(ApiError::not_found(format!(
            "Tidal track {track_id} does not use DASH playback"
        )));
    };

    proxy_direct_stream(
        &state.http_client,
        &initialization_url,
        &mime_type,
        &HeaderMap::new(),
    )
    .await
}

async fn dash_segment(
    State(state): State<AppState>,
    Path((provider, track_id, segment_number)): Path<(String, String, u32)>,
) -> Result<Response, ApiError> {
    ensure_tidal_provider(&provider)?;
    if let Some(response) = state
        .playback_cache
        .dash_response(&track_id, Some(segment_number), "audio/mp4")
        .await
    {
        return response.map_err(ApiError::internal);
    }

    let source = state
        .tidal
        .playback_source(&track_id)
        .await
        .map_err(ApiError::upstream)?;
    let PlaybackSource::Dash {
        media_url_template,
        mime_type,
        start_number,
        segment_count,
        ..
    } = source
    else {
        return Err(ApiError::not_found(format!(
            "Tidal track {track_id} does not use DASH playback"
        )));
    };

    let is_out_of_range = segment_number < start_number
        || segment_count.is_some_and(|count| segment_number >= start_number.saturating_add(count));
    if is_out_of_range {
        return Err(ApiError::not_found(format!(
            "DASH segment {segment_number} is outside this track"
        )));
    }

    let segment_url = media_url_template.replace("$Number$", &segment_number.to_string());
    proxy_direct_stream(
        &state.http_client,
        &segment_url,
        &mime_type,
        &HeaderMap::new(),
    )
    .await
}

fn ensure_tidal_provider(provider: &str) -> Result<(), ApiError> {
    if provider == "tidal" {
        Ok(())
    } else {
        Err(ApiError::not_found(format!(
            "Music provider '{provider}' is not configured"
        )))
    }
}

fn qobuz_provider(state: &AppState) -> Result<&QobuzProvider, ApiError> {
    state.qobuz.as_ref().ok_or_else(|| {
        ApiError::service_unavailable(
            "Qobuz login is not configured. Set AMBRA_QOBUZ_USER_AUTH_TOKEN, or restart with AMBRA_QOBUZ_INTERACTIVE_LOGIN=1",
        )
    })
}

fn provider_name(provider: MusicProvider) -> &'static str {
    match provider {
        MusicProvider::Tidal => "Tidal",
        MusicProvider::Qobuz => "Qobuz",
        MusicProvider::Spotify => "Spotify",
        MusicProvider::YoutubeMusic => "YouTube Music",
    }
}

async fn proxy_direct_stream(
    client: &reqwest::Client,
    url: &str,
    fallback_mime_type: &str,
    incoming_headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let mut request = client.get(url);
    if let Some(range) = incoming_headers.get(RANGE) {
        request = request.header(RANGE, range);
    }

    let upstream = request.send().await.map_err(ApiError::upstream)?;
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let stream = upstream
        .bytes_stream()
        .map_err(|error| io::Error::other(error.to_string()));

    let mut response = Response::builder()
        .status(status)
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))
        .map_err(ApiError::internal)?;

    copy_header(&upstream_headers, response.headers_mut(), CONTENT_TYPE);
    copy_header(&upstream_headers, response.headers_mut(), CONTENT_LENGTH);
    copy_header(&upstream_headers, response.headers_mut(), CONTENT_RANGE);
    copy_header(&upstream_headers, response.headers_mut(), ACCEPT_RANGES);
    copy_header(&upstream_headers, response.headers_mut(), ETAG);
    copy_header(&upstream_headers, response.headers_mut(), LAST_MODIFIED);

    if !response.headers().contains_key(CONTENT_TYPE) {
        response.headers_mut().insert(
            CONTENT_TYPE,
            HeaderValue::from_str(fallback_mime_type).map_err(ApiError::internal)?,
        );
    }

    Ok(response)
}

fn copy_header(source: &HeaderMap, destination: &mut HeaderMap, name: axum::http::HeaderName) {
    if let Some(value) = source.get(&name) {
        destination.insert(name, value.clone());
    }
}

fn configured_tidal_track_ids() -> Vec<String> {
    env::var("AMBRA_TIDAL_TRACK_IDS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|ids| !ids.is_empty())
        .unwrap_or_else(|| vec![DEFAULT_TIDAL_TRACK_ID.to_owned()])
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: String) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message,
        }
    }

    fn upstream(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: error.to_string(),
        }
    }

    fn service_unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: self.message,
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        LibraryEntry, configured_tidal_track_ids, hls_playlist_body, move_entries_to_end,
        qobuz_album_id, tidal_album_id,
    };
    use crate::models::MusicProvider;

    #[test]
    fn default_library_has_a_test_track() {
        // Environment-independent contract: configuration always produces at least one track.
        assert!(!configured_tidal_track_ids().is_empty());
    }

    #[test]
    fn extracts_tidal_album_id_from_supported_links() {
        assert_eq!(
            tidal_album_id("https://tidal.com/browse/album/353416032?u"),
            Some("353416032".to_owned())
        );
        assert_eq!(
            tidal_album_id("https://listen.tidal.com/album/12345"),
            Some("12345".to_owned())
        );
    }

    #[test]
    fn rejects_non_tidal_and_non_album_links() {
        assert_eq!(tidal_album_id("https://example.com/album/12345"), None);
        assert_eq!(tidal_album_id("https://tidal.com/browse/track/12345"), None);
    }

    #[test]
    fn extracts_qobuz_album_id_from_supported_links() {
        assert_eq!(
            qobuz_album_id("https://open.qobuz.com/album/abc123?utm_source=share"),
            Some("abc123".to_owned())
        );
        assert_eq!(
            qobuz_album_id("https://www.qobuz.com/us-en/album/album-title/0123456789abc"),
            Some("0123456789abc".to_owned())
        );
    }

    #[test]
    fn rejects_non_qobuz_and_non_album_links() {
        assert_eq!(qobuz_album_id("https://example.com/album/abc123"), None);
        assert_eq!(qobuz_album_id("https://play.qobuz.com/artist/12345"), None);
    }

    #[test]
    fn moves_existing_track_into_imported_album_order() {
        let tidal = |provider_track_id: &str| LibraryEntry {
            provider: MusicProvider::Tidal,
            provider_track_id: provider_track_id.to_owned(),
        };
        let qobuz = |provider_track_id: &str| LibraryEntry {
            provider: MusicProvider::Qobuz,
            provider_track_id: provider_track_id.to_owned(),
        };
        let mut library = vec![tidal("5"), qobuz("5"), tidal("other")];

        move_entries_to_end(
            &mut library,
            ["1", "2", "3", "4", "5"].into_iter().map(tidal).collect(),
        );

        assert_eq!(
            library,
            [
                qobuz("5"),
                tidal("other"),
                tidal("1"),
                tidal("2"),
                tidal("3"),
                tidal("4"),
                tidal("5")
            ]
        );
    }

    #[test]
    fn creates_native_hls_playlist_from_dash_timing() {
        let playlist = hls_playlist_body(44_100, 176_128, 1, 2, 8).unwrap();

        assert!(playlist.contains("#EXT-X-MAP:URI=\"dash/init\""));
        assert!(playlist.contains("#EXTINF:3.993832,\ndash/1"));
        assert!(playlist.contains("#EXTINF:3.993832,\ndash/2"));
        assert!(playlist.ends_with("#EXT-X-ENDLIST\n"));
    }
}
