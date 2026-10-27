use crate::{ConnectionManager, Result};
use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use std::sync::Arc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct BridgeState {
    manager: Arc<ConnectionManager>,
    capability: String,
    host: String,
}
/// The capability is per process and grants access only to this selected server.
pub struct Bridge {
    pub base_url: String,
    cancel: CancellationToken,
    task: JoinHandle<()>,
    manager_task: JoinHandle<()>,
}
impl Bridge {
    pub async fn start(manager: Arc<ConnectionManager>) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let mut secret = [0; 32];
        getrandom::fill(&mut secret).map_err(|e| std::io::Error::other(e.to_string()))?;
        let capability = hex::encode(secret);
        let state = BridgeState {
            manager: manager.clone(),
            capability: capability.clone(),
            host: address.to_string(),
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
        })
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
    let mut response = match state.manager.request(request).await {
        Ok(response) => response.map(Body::new),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Selected Ambra server is offline",
        )
            .into_response(),
    };
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
