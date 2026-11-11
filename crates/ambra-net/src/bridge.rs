use crate::{ConnectionManager, Result, media_cache::{self, MediaCache}};
use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use bytes::Bytes;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct BridgeState {
    manager: Arc<ConnectionManager>,
    capability: String,
    host: String,
    cache: Option<Arc<MediaCache>>,
    covers: Arc<Mutex<CoverCache>>,
}

const COVER_PATH: &str = "/api/artwork/thumbnail?";
const COVER_CACHE_BYTES: usize = 32 * 1024 * 1024;
/// A thumbnail is a few tens of kilobytes; anything much larger isn't one.
const COVER_MAX_BYTES: usize = 512 * 1024;

/// Cover thumbnails already fetched from the selected server, for this run only and only in
/// memory. Every response leaves the bridge as `no-store` (its URLs hold the capability), so
/// the app asks again each time a cover scrolls back into view; a thumbnail's URL names its
/// source image, so the answer is the same every time. Answering from here spares the
/// connection a round trip per cover, which matters most on a slow path away from home.
#[derive(Default)]
struct CoverCache {
    entries: HashMap<String, (Option<header::HeaderValue>, Bytes)>,
    /// Least recently used first.
    order: VecDeque<String>,
    bytes: usize,
}
impl CoverCache {
    fn get(&mut self, key: &str) -> Option<(Option<header::HeaderValue>, Bytes)> {
        let found = self.entries.get(key)?.clone();
        if let Some(index) = self.order.iter().position(|entry| entry == key) {
            let key = self.order.remove(index).expect("found above");
            self.order.push_back(key);
        }
        Some(found)
    }
    fn insert(&mut self, key: String, content_type: Option<header::HeaderValue>, body: Bytes) {
        if body.is_empty() || body.len() > COVER_MAX_BYTES || self.entries.contains_key(&key) {
            return;
        }
        while self.bytes + body.len() > COVER_CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some((_, removed)) = self.entries.remove(&oldest) {
                self.bytes -= removed.len();
            }
        }
        self.bytes += body.len();
        self.order.push_back(key.clone());
        self.entries.insert(key, (content_type, body));
    }
}

fn cover_response(content_type: Option<header::HeaderValue>, body: Bytes) -> Response {
    let mut response = Response::new(Body::from(body));
    if let Some(content_type) = content_type {
        response.headers_mut().insert(header::CONTENT_TYPE, content_type);
    }
    response
}

/// A cover from the server: its whole body is read, kept, and passed on. Anything that
/// isn't a complete, successful image goes to the app as it came.
async fn fetch_cover(state: &BridgeState, path: &str, request: Request) -> Response {
    use http_body_util::BodyExt;
    let response = match state.manager.request(request).await {
        Ok(response) => response,
        Err(_) => return (StatusCode::SERVICE_UNAVAILABLE, "Selected Ambra server is offline").into_response(),
    };
    if response.status() != StatusCode::OK {
        return response.map(Body::new);
    }
    let (parts, body) = response.into_parts();
    match http_body_util::Limited::new(body, COVER_MAX_BYTES).collect().await {
        Ok(collected) => {
            let body = collected.to_bytes();
            let content_type = parts.headers.get(header::CONTENT_TYPE).cloned();
            state.covers.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(path.to_owned(), content_type.clone(), body.clone());
            cover_response(content_type, body)
        }
        // Cut off on the way, or not a thumbnail after all: the app retries as it would have.
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}
/// The capability is per process and grants access only to this selected server.
pub struct Bridge {
    pub base_url: String,
    cancel: CancellationToken,
    task: JoinHandle<()>,
    manager_task: JoinHandle<()>,
    cache: Option<Arc<MediaCache>>,
}
impl Bridge {
    pub async fn start(manager: Arc<ConnectionManager>) -> Result<Self> {
        Self::start_with_cache(manager, None).await
    }
    /// With a cache directory, audio is downloaded ahead of the player and survives reconnects.
    pub async fn start_with_cache(manager: Arc<ConnectionManager>, cache_directory: Option<std::path::PathBuf>) -> Result<Self> {
        let cache = cache_directory.map(|directory| MediaCache::new(manager.clone(), directory)).transpose()?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let mut secret = [0; 32];
        getrandom::fill(&mut secret).map_err(|e| std::io::Error::other(e.to_string()))?;
        let capability = hex::encode(secret);
        let state = BridgeState {
            manager: manager.clone(),
            capability: capability.clone(),
            host: address.to_string(),
            cache: cache.clone(),
            covers: Default::default(),
        };
        let app = Router::new().fallback(any(forward)).with_state(state);
        let cancel = manager.cancel.clone();
        let stop = cancel.clone();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(stop.cancelled_owned())
                .await;
        });
        let manager_task = tokio::spawn(async move {
            manager.run().await;
        });
        Ok(Self {
            base_url: format!("http://{address}/{capability}"),
            cancel,
            task,
            manager_task,
            cache,
        })
    }
    /// Downloads a song the player will need next. `path` is a server path such as `/api/...`.
    pub fn prefetch(&self, path: &str) {
        if let Some(cache) = &self.cache {
            cache.prefetch(path);
        }
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.task.abort(); /* manager observes cancellation and destroys DHT */
    }
}
impl Bridge {
    pub async fn shutdown(mut self) {
        self.cancel.cancel();
        let _ =
            tokio::time::timeout(std::time::Duration::from_secs(3), &mut self.manager_task).await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), &mut self.task).await;
        self.manager_task.abort();
        self.task.abort();
    }
    pub fn is_finished(&self) -> bool {
        self.task.is_finished() || self.manager_task.is_finished()
    }
}
fn allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:1420"
            | "http://127.0.0.1:1420"
    )
}
fn target(request: &Request, state: &BridgeState) -> Option<String> {
    if request.headers().get(header::HOST)?.to_str().ok()? != state.host {
        return None;
    }
    if request
        .headers()
        .get(header::ORIGIN)
        .is_some_and(|v| !v.to_str().is_ok_and(allowed_origin))
    {
        return None;
    }
    if request.uri().scheme().is_some() || request.uri().authority().is_some() {
        return None;
    }
    let path = request
        .uri()
        .path()
        .strip_prefix(&format!("/{}/", state.capability))?;
    if !path.starts_with("api/") || path.starts_with("api/local/") || path == "api/local" {
        return None;
    }
    let query = request
        .uri()
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty() && p.split('=').next() != Some("access_token"))
        .collect::<Vec<_>>()
        .join("&");
    Some(format!(
        "/{path}{}",
        if query.is_empty() {
            String::new()
        } else {
            format!("?{query}")
        }
    ))
}
async fn forward(State(state): State<BridgeState>, mut request: Request) -> Response {
    let Some(path) = target(&request, &state) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let origin = request.headers().get(header::ORIGIN).cloned();
    if request.method() == hyper::Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        cors(&mut response, origin);
        return response;
    }
    let Ok(uri) = path.parse() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    *request.uri_mut() = uri;
    request.headers_mut().remove(header::ORIGIN);
    let cached = state.cache.as_ref().filter(|_| {
        matches!(*request.method(), hyper::Method::GET | hyper::Method::HEAD) && media_cache::cacheable(&path)
    });
    let cover = *request.method() == hyper::Method::GET && path.starts_with(COVER_PATH) && !request.headers().contains_key(header::RANGE);
    let kept = if cover { state.covers.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&path) } else { None };
    let mut response = if let Some((content_type, body)) = kept {
        cover_response(content_type, body)
    } else if cover {
        fetch_cover(&state, &path, request).await
    } else if let Some(cache) = cached {
        cache.serve(&path, request.method(), request.headers()).await
    } else { match state.manager.request(request).await {
        Ok(response) => response.map(Body::new),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Selected Ambra server is offline",
        )
            .into_response(),
    } };
    // Never cache capability URLs or expose paired tokens through forwarded redirects/cookies.
    response.headers_mut().remove(header::SET_COOKIE);
    response.headers_mut().remove(header::LOCATION);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        "no-store".parse().expect("valid header"),
    );
    cors(&mut response, origin);
    response
}
fn cors(response: &mut Response, origin: Option<hyper::header::HeaderValue>) {
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .insert(header::VARY, "Origin".parse().expect("valid header"));
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
                .parse()
                .expect("valid header"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "authorization, content-type, range"
                .parse()
                .expect("valid header"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "content-length, content-range, accept-ranges, content-type"
                .parse()
                .expect("valid header"),
        );
        response.headers_mut().insert(
            "access-control-allow-private-network",
            "true".parse().expect("valid header"),
        );
    }
}

#[cfg(test)]
mod cover_cache_tests {
    use super::*;

    #[test]
    fn covers_are_kept_up_to_the_budget_and_the_least_recently_used_leave_first() {
        let mut covers = CoverCache::default();
        let cover = Bytes::from(vec![7; COVER_MAX_BYTES]);
        let fits = COVER_CACHE_BYTES / COVER_MAX_BYTES;
        for index in 0..fits {
            covers.insert(format!("cover-{index}"), None, cover.clone());
        }
        assert_eq!(covers.bytes, COVER_CACHE_BYTES);
        // Looked at again, the first cover outlives the second when room is needed.
        assert!(covers.get("cover-0").is_some());
        covers.insert("one-more".into(), Some(header::HeaderValue::from_static("image/jpeg")), cover.clone());
        assert!(covers.get("cover-0").is_some());
        assert!(covers.get("cover-1").is_none());
        assert_eq!(covers.get("one-more").unwrap().0.unwrap(), "image/jpeg");
        assert_eq!(covers.bytes, COVER_CACHE_BYTES);
        assert_eq!(covers.entries.len(), covers.order.len());
        // Not thumbnails: nothing, or far too much.
        covers.insert("empty".into(), None, Bytes::new());
        covers.insert("huge".into(), None, Bytes::from(vec![0; COVER_MAX_BYTES + 1]));
        assert!(covers.get("empty").is_none() && covers.get("huge").is_none());
    }
}
