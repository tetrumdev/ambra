//! The phone remote (desktop/remote), served at `/remote/` so a phone on the network can open
//! it in Safari and add it to its home screen. It's a paired device like any other: the page
//! itself is public, everything it asks of the server needs its token.
//!
//! Files are read from disk on every request, so `bun run --cwd desktop remote:watch` shows
//! a change on the next reload without restarting the server. `AMBRA_REMOTE_DIR` points
//! elsewhere; by default it's the build output in this checkout.

use std::{env, path::PathBuf};

use axum::{
    Router,
    http::{HeaderValue, header::CACHE_CONTROL},
    middleware,
    response::Response,
};
use tower_http::services::ServeDir;

pub const PATH: &str = "/remote";

fn directory() -> PathBuf {
    env::var_os("AMBRA_REMOTE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../desktop/dist-remote")))
}

/// Always asks before using a cached copy, so a rebuilt remote shows up on the next open.
async fn revalidate(mut response: Response) -> Response {
    response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .nest_service(PATH, ServeDir::new(directory()).append_index_html_on_directories(true))
        .layer(middleware::map_response(revalidate))
}
