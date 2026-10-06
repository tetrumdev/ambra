//! Keeps the local server private to the Ambra app.
//!
//! The server holds signed-in provider sessions and serves decrypted audio, so a
//! web page in the user's browser must not be able to drive it. Browsers attach
//! `Origin` to cross-origin API calls and form posts, and a DNS-rebinding page
//! reaches the loopback port under its own host name; both are rejected here.

use std::{env, net::SocketAddr, sync::Arc};

use axum::{
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header::HOST, header::ORIGIN},
    middleware::Next,
    response::{IntoResponse, Response},
};

/// The app's own webview origins: macOS/Linux, Windows (WebView2), and the Vite dev server.
const APP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
];

#[derive(Clone)]
pub struct AccessPolicy {
    origins: Arc<Vec<String>>,
    loopback_only: bool,
}

impl AccessPolicy {
    /// `AMBRA_ALLOWED_ORIGINS` (comma-separated) admits additional front ends.
    pub fn from_env(address: &str) -> Self {
        let mut origins = APP_ORIGINS
            .iter()
            .map(|origin| (*origin).to_owned())
            .collect::<Vec<_>>();
        if let Ok(extra) = env::var("AMBRA_ALLOWED_ORIGINS") {
            origins.extend(
                extra
                    .split(',')
                    .map(|origin| origin.trim().trim_end_matches('/').to_owned())
                    .filter(|origin| !origin.is_empty()),
            );
        }
        Self {
            origins: Arc::new(origins),
            loopback_only: address
                .parse::<SocketAddr>()
                .is_ok_and(|address| address.ip().is_loopback()),
        }
    }

    pub fn origin_values(&self) -> Vec<HeaderValue> {
        self.origins
            .iter()
            .filter_map(|origin| HeaderValue::from_str(origin).ok())
            .collect()
    }

    fn allows_origin(&self, origin: &[u8]) -> bool {
        self.origins.iter().any(|allowed| allowed.as_bytes() == origin)
    }

    fn allows_host(&self, host: &[u8]) -> bool {
        if !self.loopback_only {
            return true;
        }
        let Ok(host) = std::str::from_utf8(host) else {
            return false;
        };
        let name = match host.strip_prefix('[') {
            Some(bracketed) => bracketed.split(']').next().unwrap_or_default(),
            None => host.split(':').next().unwrap_or_default(),
        };
        matches!(
            name.to_ascii_lowercase().as_str(),
            "127.0.0.1" | "localhost" | "::1"
        )
    }
}

pub async fn enforce(State(policy): State<AccessPolicy>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    if let Some(host) = headers.get(HOST)
        && !policy.allows_host(host.as_bytes())
    {
        return (StatusCode::FORBIDDEN, "Unrecognized host").into_response();
    }
    if let Some(origin) = headers.get(ORIGIN)
        && !policy.allows_origin(origin.as_bytes())
    {
        return (StatusCode::FORBIDDEN, "Origin is not allowed").into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::AccessPolicy;

    #[test]
    fn loopback_server_only_answers_loopback_host_names() {
        let policy = AccessPolicy::from_env("127.0.0.1:38147");
        assert!(policy.allows_host(b"127.0.0.1:38147"));
        assert!(policy.allows_host(b"localhost:38147"));
        assert!(policy.allows_host(b"[::1]:38147"));
        assert!(!policy.allows_host(b"attacker.example:38147"));
        assert!(!policy.allows_host(b"127.0.0.1.attacker.example"));
    }

    #[test]
    fn network_bound_server_leaves_host_names_alone() {
        let policy = AccessPolicy::from_env("0.0.0.0:38147");
        assert!(policy.allows_host(b"ambra.lan:38147"));
    }

    #[test]
    fn only_app_origins_are_allowed() {
        let policy = AccessPolicy::from_env("127.0.0.1:38147");
        assert!(policy.allows_origin(b"tauri://localhost"));
        assert!(policy.allows_origin(b"http://tauri.localhost"));
        assert!(!policy.allows_origin(b"https://example.com"));
        assert!(!policy.allows_origin(b"null"));
    }
}
