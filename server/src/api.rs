use std::{env, io, time::Duration};

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
    routing::get,
};
use futures_util::TryStreamExt;
use serde::Serialize;
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
    tidal_track_ids: Vec<String>,
}

pub async fn serve() -> ServerResult<()> {
    let state = AppState {
        tidal: TidalProvider::authenticate().await?,
        http_client: reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?,
        tidal_track_ids: configured_tidal_track_ids(),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::HEAD])
        .allow_headers([RANGE, CONTENT_TYPE])
        .expose_headers([CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES, CONTENT_TYPE])
        .allow_private_network(true);

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/library", get(library))
        .route(
            "/api/providers/{provider}/tracks/{track_id}/stream",
            get(stream_track),
        )
        .route(
            "/api/providers/{provider}/tracks/{track_id}/manifest.mpd",
            get(dash_manifest),
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
    let mut tracks = Vec::with_capacity(state.tidal_track_ids.len());
    for track_id in &state.tidal_track_ids {
        tracks.push(
            state
                .tidal
                .track_metadata(track_id)
                .await
                .map_err(ApiError::upstream)?,
        );
    }

    Ok(Json(LibraryResponse { tracks }))
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
    use super::configured_tidal_track_ids;

    #[test]
    fn default_library_has_a_test_track() {
        // Environment-independent contract: configuration always produces at least one track.
        assert!(!configured_tidal_track_ids().is_empty());
    }
}
