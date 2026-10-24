//! Convolution impulse files, kept by the server so every device's DSP presets can use them.
//! A device uploads a file when it imports one and downloads those it lacks; the presets
//! themselves are shared listening state (`ambra.dsp-presets.v1`).

use std::path::PathBuf;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path},
    http::{StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;

/// The same limit the app applies when importing.
const MAX_IMPULSE_BYTES: usize = 8 * 1024 * 1024;

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/api/impulses/{impulse_id}", get(download).post(upload))
        .layer(DefaultBodyLimit::max(MAX_IMPULSE_BYTES + 1024))
}

fn path(id: &str) -> Option<PathBuf> {
    let valid = !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    valid.then(|| crate::storage::data_path("dsp-impulses").join(format!("{id}.wav")))
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

async fn download(Path(id): Path<String>) -> Response {
    let Some(path) = path(&id) else { return error(StatusCode::BAD_REQUEST, "Invalid impulse ID") };
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([(CONTENT_TYPE, "audio/wav")], bytes).into_response(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => error_not_found(),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Could not read the impulse file"),
    }
}

fn error_not_found() -> Response {
    error(StatusCode::NOT_FOUND, "The server doesn't have that impulse file")
}

/// IDs are unique per import, so a file never changes once uploaded; uploading again is a no-op.
async fn upload(Path(id): Path<String>, bytes: Bytes) -> Response {
    let Some(path) = path(&id) else { return error(StatusCode::BAD_REQUEST, "Invalid impulse ID") };
    if bytes.len() > MAX_IMPULSE_BYTES || bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return error(StatusCode::BAD_REQUEST, "Impulse files must be WAV files of at most 8 MB");
    }
    if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        return Json(json!({})).into_response();
    }
    let saved = tokio::task::spawn_blocking(move || crate::server_config::write_private(&path, &bytes)).await;
    match saved {
        Ok(Ok(())) => Json(json!({})).into_response(),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Could not save the impulse file"),
    }
}
