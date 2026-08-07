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
    models::{HealthResponse, LibraryResponse},
    providers::tidal::{PlaybackSource, TidalProvider},
};

const DEFAULT_ADDRESS: &str = "127.0.0.1:8787";
const DEFAULT_TIDAL_TRACK_ID: &str = "3756725";

type ServerResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone)]
struct AppState {
    tidal: TidalProvider,
    http_client: reqwest::Client,
    tidal_track_ids: Arc<RwLock<Vec<String>>>,
}

pub async fn serve() -> ServerResult<()> {
    let state = AppState {
        tidal: TidalProvider::authenticate().await?,
        http_client: reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?,
        tidal_track_ids: Arc::new(RwLock::new(initial_tidal_track_ids())),
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
        .route("/api/library/tidal-albums", post(add_tidal_album))
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

async fn library(State(state): State<AppState>) -> Result<Json<LibraryResponse>, ApiError> {
    let track_ids = state.tidal_track_ids.read().await.clone();
    let tracks = load_tidal_tracks(&state.tidal, &track_ids).await?;

    Ok(Json(LibraryResponse { tracks }))
}

#[derive(Deserialize)]
struct AddTidalAlbumRequest {
    url: String,
}

async fn add_tidal_album(
    State(state): State<AppState>,
    Json(request): Json<AddTidalAlbumRequest>,
) -> Result<Json<LibraryResponse>, ApiError> {
    let album_id = tidal_album_id(&request.url)
        .ok_or_else(|| ApiError::bad_request("Invalid Tidal album link"))?;
    let track_ids = state
        .tidal
        .album_track_ids(&album_id)
        .await
        .map_err(ApiError::upstream)?;

    if track_ids.is_empty() {
        return Err(ApiError::not_found(format!(
            "Tidal album {album_id} contains no tracks"
        )));
    }

    let tracks = load_tidal_tracks(&state.tidal, &track_ids).await?;

    let mut library_track_ids = state.tidal_track_ids.write().await;
    move_track_ids_to_end(&mut library_track_ids, track_ids);
    if let Err(error) = save_library_track_ids(&library_track_ids) {
        eprintln!("Could not persist the streaming library cache: {error}");
    }

    Ok(Json(LibraryResponse { tracks }))
}

async fn load_tidal_tracks(
    tidal: &TidalProvider,
    track_ids: &[String],
) -> Result<Vec<crate::models::TrackMetadata>, ApiError> {
    stream::iter(track_ids.iter().cloned())
        .map(|track_id| {
            let tidal = tidal.clone();
            async move { tidal.track_metadata(&track_id).await }
        })
        .buffered(4)
        .map_err(ApiError::upstream)
        .try_collect()
        .await
}

fn move_track_ids_to_end(library: &mut Vec<String>, ordered_track_ids: Vec<String>) {
    let incoming_ids = ordered_track_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    library.retain(|track_id| !incoming_ids.contains(track_id.as_str()));
    library.extend(ordered_track_ids);
}

fn initial_tidal_track_ids() -> Vec<String> {
    let configured = configured_tidal_track_ids();
    let mut cached = load_library_track_ids();
    let cached_ids = cached.iter().map(String::as_str).collect::<HashSet<_>>();
    let missing_configured = configured
        .into_iter()
        .filter(|track_id| !cached_ids.contains(track_id.as_str()))
        .collect::<Vec<_>>();
    cached.splice(0..0, missing_configured);
    cached
}

fn library_track_ids_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".library-track-ids.json")
}

fn load_library_track_ids() -> Vec<String> {
    let path = library_track_ids_path();
    let encoded = match fs::read(&path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
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

fn save_library_track_ids(track_ids: &[String]) -> io::Result<()> {
    let path = library_track_ids_path();
    let temporary_path = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary_path, serde_json::to_vec(track_ids)?)?;
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

async fn stream_track(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if provider != "tidal" {
        return Err(ApiError::not_found(format!(
            "Music provider '{provider}' is not configured"
        )));
    }

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
        configured_tidal_track_ids, hls_playlist_body, move_track_ids_to_end, tidal_album_id,
    };

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
    fn moves_existing_track_into_imported_album_order() {
        let mut library = vec!["5".to_owned(), "other".to_owned()];

        move_track_ids_to_end(
            &mut library,
            ["1", "2", "3", "4", "5"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
        );

        assert_eq!(library, ["other", "1", "2", "3", "4", "5"]);
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
