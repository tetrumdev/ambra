//! Decides who may use the server.
//!
//! The server holds signed-in provider sessions and serves decrypted audio, so:
//!
//! * a web page in the user's browser must not drive it: browsers attach `Origin` to
//!   cross-origin calls, and only the app's own origins are accepted, plus pages this server
//!   served itself (the phone remote), which still need a token like any other device;
//! * the server machine itself is trusted, but only when the request both comes from a
//!   loopback address and names a loopback host, so a DNS-rebinding page that reaches the
//!   port under its own host name is not mistaken for the local app;
//! * any other device must be paired and send its token, as `Authorization: Bearer …` or,
//!   for media elements that can't set headers, an `access_token` query parameter.
//!   Unpaired devices may only ask what the server is and ask to pair.

use std::{env, net::SocketAddr, sync::Arc};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{HeaderValue, Method, StatusCode, Uri, header::AUTHORIZATION, header::HOST, header::ORIGIN},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::network::SharedNetwork;

/// The app's own webview origins: macOS/Linux, Windows (WebView2), and the Vite dev server.
const APP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
];
/// Pairing approval and server settings, for the server machine only.
pub const LOCAL_ONLY_PREFIX: &str = "/api/local/";
const PUBLIC_PATHS: &[&str] = &["/api/health", "/api/server/info", "/api/pair/request", crate::remote::PATH];
pub const TOKEN_PARAMETER: &str = "access_token";

/// A validated paired-device credential, for media manifests whose child requests
/// cannot inherit the original request's authorization header or query string.
#[derive(Clone)]
pub struct MediaAccessToken(pub String);

#[derive(Clone)]
pub struct Caller { pub client_id: Option<String> }

#[derive(Clone)]
pub struct AccessPolicy {
    origins: Arc<Vec<String>>,
    network: SharedNetwork,
}

impl AccessPolicy {
    /// `AMBRA_ALLOWED_ORIGINS` (comma-separated) admits additional front ends.
    pub fn from_env(network: SharedNetwork) -> Self {
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
            network,
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
}

fn loopback_host(host: &[u8]) -> bool {
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

/// A page this server served calling back to it. A DNS-rebinding page can pass this too, under
/// its own host name, but never counts as local and has no paired token.
fn same_origin(origin: &[u8], host: Option<&HeaderValue>) -> bool {
    host.is_some_and(|host| origin.strip_prefix(b"http://") == Some(host.as_bytes()))
}

fn public_path(path: &str) -> bool {
    PUBLIC_PATHS
        .iter()
        .any(|public| path == *public || path.strip_prefix(public).is_some_and(|rest| rest.starts_with('/')))
}

/// The token from the header or query, and the URI without the query parameter, so handlers
/// that parse their own query never see it.
fn take_token(request: &Request) -> (Option<String>, Option<Uri>) {
    let header = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|token| token.trim().to_owned());
    let uri = request.uri();
    let Some(query) = uri.query() else {
        return (header, None);
    };
    let mut token = None;
    let kept = query
        .split('&')
        .filter(|pair| match pair.strip_prefix(TOKEN_PARAMETER).and_then(|rest| rest.strip_prefix('=')) {
            Some(value) => {
                token = urlencoding::decode(value).ok().map(|value| value.into_owned());
                false
            }
            None => true,
        })
        .collect::<Vec<_>>()
        .join("&");
    if token.is_none() {
        return (header, None);
    }
    let path_and_query = if kept.is_empty() { uri.path().to_owned() } else { format!("{}?{kept}", uri.path()) };
    let mut parts = uri.clone().into_parts();
    parts.path_and_query = path_and_query.parse().ok();
    (header.or(token), Uri::from_parts(parts).ok())
}

pub async fn enforce(State(policy): State<AccessPolicy>, mut request: Request, next: Next) -> Response {
    let headers = request.headers();
    if let Some(origin) = headers.get(ORIGIN)
        && !policy.allows_origin(origin.as_bytes())
        && !same_origin(origin.as_bytes(), headers.get(HOST))
    {
        return (StatusCode::FORBIDDEN, "Origin is not allowed").into_response();
    }
    let peer_is_loopback = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|ConnectInfo(peer)| peer.ip().is_loopback());
    let local = peer_is_loopback && headers.get(HOST).is_none_or(|host| loopback_host(host.as_bytes()));
    let path = request.uri().path().to_owned();

    if path.starts_with(LOCAL_ONLY_PREFIX) {
        return if local {
            next.run(request).await
        } else {
            (StatusCode::FORBIDDEN, "Only the server machine can change pairing and settings").into_response()
        };
    }
    // Preflights carry no credentials; CORS answers them, and the real request is checked.
    if local { request.extensions_mut().insert(Caller { client_id: None }); }
    if local || request.method() == Method::OPTIONS || public_path(&path) {
        return next.run(request).await;
    }
    let (token, stripped) = take_token(&request);
    let authenticated = token.and_then(|token| {
        policy.network.paired_client_id(&token).map(|client_id| (token, client_id))
    });
    let Some((token, client_id)) = authenticated else {
        return (StatusCode::UNAUTHORIZED, "Pair this device with the server first").into_response();
    };
    request.extensions_mut().insert(Caller { client_id: Some(client_id) });
    request.extensions_mut().insert(MediaAccessToken(token));
    if let Some(uri) = stripped {
        *request.uri_mut() = uri;
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_host_names_count_as_local() {
        assert!(loopback_host(b"127.0.0.1:38147"));
        assert!(loopback_host(b"localhost:38147"));
        assert!(loopback_host(b"[::1]:38147"));
        assert!(!loopback_host(b"attacker.example:38147"));
        assert!(!loopback_host(b"127.0.0.1.attacker.example"));
        assert!(!loopback_host(b"192.168.1.20:38147"));
    }

    #[test]
    fn public_paths_match_whole_segments() {
        assert!(public_path("/api/pair/request"));
        assert!(public_path("/api/pair/request/abc"));
        assert!(public_path("/api/server/info"));
        assert!(!public_path("/api/pair/requests"));
        assert!(!public_path("/api/state"));
        assert!(public_path("/remote"));
        assert!(public_path("/remote/assets/index.js"));
        assert!(!public_path("/remoteness"));
    }

    #[test]
    fn same_origin_needs_a_matching_host() {
        let host = HeaderValue::from_static("192.168.1.20:38147");
        assert!(same_origin(b"http://192.168.1.20:38147", Some(&host)));
        assert!(!same_origin(b"http://evil.example", Some(&host)));
        assert!(!same_origin(b"https://192.168.1.20:38147", Some(&host)));
        assert!(!same_origin(b"http://192.168.1.20:38147", None));
    }

    #[test]
    fn the_query_token_is_read_and_removed() {
        let request = Request::builder()
            .uri("/api/artwork/thumbnail?url=x&access_token=abc%2Bd&size=3")
            .body(axum::body::Body::empty())
            .unwrap();
        let (token, uri) = take_token(&request);
        assert_eq!(token.as_deref(), Some("abc+d"));
        assert_eq!(uri.unwrap().to_string(), "/api/artwork/thumbnail?url=x&size=3");
    }

    #[tokio::test]
    async fn only_validated_credentials_reach_media_handlers() {
        use axum::{Extension, Json, Router, middleware, routing::get};
        let mut config = crate::server_config::ServerConfig::load_default_for_tests();
        config.paired_clients.push(crate::server_config::PairedClient {
            id: "phone".into(), name: "Phone".into(),
            token_sha256: crate::server_config::token_hash("test+token"), paired_at_ms: 0,
        });
        let policy = AccessPolicy::from_env(crate::network::Network::new(config));
        let router = Router::new().route("/protected", get(
            |uri: Uri, credential: Option<Extension<MediaAccessToken>>, caller: Extension<Caller>| async move {
                Json(serde_json::json!({ "uri": uri.to_string(), "token": credential.map(|Extension(token)| token.0), "client_id": caller.0.client_id }))
            },
        )).layer(middleware::from_fn_with_state(policy, enforce));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
        });
        let client = reqwest::Client::new();
        for query in [false, true] {
            let url = format!("http://{address}/protected{}", if query { "?access_token=test%2Btoken" } else { "" });
            let mut request = client.get(url).header(HOST, "paired-device");
            if !query { request = request.bearer_auth("test+token"); }
            let response = request.send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(body["token"], "test+token");
            assert_eq!(body["client_id"], "phone");
            assert_eq!(body["uri"], "/protected");
        }
        for suffix in ["", "?access_token=wrong"] {
            let response = client.get(format!("http://{address}/protected{suffix}"))
                .header(HOST, "paired-device").send().await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        server.abort();
    }

    #[test]
    fn only_app_origins_are_allowed() {
        let network = crate::network::Network::new(crate::server_config::ServerConfig::load_default_for_tests());
        let policy = AccessPolicy::from_env(network);
        assert!(policy.allows_origin(b"tauri://localhost"));
        assert!(policy.allows_origin(b"http://tauri.localhost"));
        assert!(!policy.allows_origin(b"https://example.com"));
        assert!(!policy.allows_origin(b"null"));
    }
}
