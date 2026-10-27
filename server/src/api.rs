mod credits;
mod discover;
mod playlists;

use crate::loudness::Loudness;
use crate::media_cache::MediaCache;
use std::{
    collections::{HashMap, HashSet},
    env, fs, io,
    path::PathBuf,
    sync::{Arc, RwLock as SyncRwLock, Weak},
    time::{Duration, Instant},
};

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Path, Query, Request, State},
    http::{
        HeaderMap, HeaderValue, Method, StatusCode,
        header::{
            ACCEPT_RANGES, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE,
            CONTENT_TYPE, ETAG, LAST_MODIFIED, RANGE,
        },
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use bytes::Bytes;
use futures_util::{StreamExt, TryStreamExt, stream};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock, watch};
use tokio_stream::wrappers::ReceiverStream;
use tower_http::compression::{CompressionLayer, Predicate, predicate::SizeAbove};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::{
    artwork_quality::{
        ArtworkCandidate, highest_resolution, image_dimensions, normalized_upc,
        qobuz_max_artwork_url, trusted_artwork_url,
    },
    models::{
        HealthResponse, LibraryResponse, MusicProvider, SearchPage, TrackMetadata,
        TrackPlaybackMetadata,
    },
    providers::qobuz::{QobuzLogin, QobuzProvider},
    providers::spotify::SpotifyProvider,
    providers::tidal::{PlaybackSource, TidalLogin, TidalProvider},
};

const DEFAULT_SEARCH_PAGE_SIZE: u32 = 10;
const MAX_SEARCH_PAGE_SIZE: u32 = 50;
const SEARCH_CACHE_LIMIT: usize = 100;
const SEARCH_METADATA_TIMEOUT: Duration = Duration::from_secs(6);
const UPSTREAM_ATTEMPTS: usize = 3;
// Saved provider sessions are restored after the port is open. Requests that
// need a provider wait at most this long for restoration before getting a 503,
// which the desktop app treats as "keep showing the cached data".
const PROVIDER_RESTORE_WAIT: Duration = Duration::from_secs(20);

type ServerResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
type ArtistMetadataCache = HashMap<
    (MusicProvider, String),
    (
        Instant,
        Arc<tokio::sync::OnceCell<crate::models::ArtistProfileMetadata>>,
    ),
>;

#[derive(Clone)]
struct AppState {
    tidal: Arc<ProviderSlot<TidalProvider>>,
    qobuz: Arc<ProviderSlot<QobuzProvider>>,
    service_login: Arc<[Mutex<()>; 3]>,
    spotify: Arc<SyncRwLock<Option<SpotifyProvider>>>,
    spotify_login: Arc<Mutex<()>>,
    soloist: Arc<crate::soloist::Manager>,
    pending_tidal_login: Arc<Mutex<Option<TidalLogin>>>,
    pending_qobuz_login: Arc<Mutex<Option<QobuzLogin>>>,
    http_client: reqwest::Client,
    library_entries: Arc<RwLock<Vec<LibraryEntry>>>,
    search_cache: Arc<RwLock<HashMap<SearchCacheKey, CachedSearchPage>>>,
    catalog_cache:
        Arc<RwLock<HashMap<SearchCacheKey, (Instant, crate::models::CatalogSearchPage)>>>,
    search_fetches: Arc<Mutex<HashMap<SearchCacheKey, Weak<Mutex<()>>>>>,
    media_cache: Arc<RwLock<MediaCache>>,
    providers_ready: watch::Receiver<bool>,
    media_fetches: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
    artwork_quality_cache: Arc<RwLock<HashMap<String, (Instant, ArtworkCandidate)>>>,
    artwork_dimensions_cache: Arc<RwLock<HashMap<String, (Instant, (u32, u32))>>>,
    artwork: Arc<crate::artwork_cache::ArtworkCache>,
    artist_metadata: Arc<Mutex<ArtistMetadataCache>>,
    playlist_mutations: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
    discover: Arc<discover::Discover>,
    user_state: Arc<crate::user_state::UserState>,
}

/// Requests own a cheap provider clone; signing out can remove the active session.
#[derive(Default)]
struct ProviderSlot<T>(SyncRwLock<Option<T>>);
impl<T: Clone> ProviderSlot<T> {
    fn new() -> Self { Self(SyncRwLock::new(None)) }
    fn get(&self) -> Option<T> { self.0.read().unwrap_or_else(|e| e.into_inner()).clone() }
    fn set(&self, provider: T) { *self.0.write().unwrap_or_else(|e| e.into_inner()) = Some(provider); }
    fn clear(&self) { *self.0.write().unwrap_or_else(|e| e.into_inner()) = None; }
}

impl AppState {
    fn login_lock(&self, provider: &str) -> Result<&Mutex<()>, ApiError> {
        let index = match provider {
            "tidal" => 0, "qobuz" => 1, "spotify" => 2,
            _ => return Err(ApiError::not_found("Unknown music service".into())),
        };
        Ok(&self.service_login[index])
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct SearchCacheKey {
    provider: MusicProvider,
    query: String,
    offset: u32,
    limit: u32,
}

#[derive(Clone)]
struct CachedSearchPage {
    page: SearchPage,
    cached_at: Instant,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryEntry {
    provider: MusicProvider,
    provider_track_id: String,
}

/// `bind` (from the command line) overrides the saved setting; `AMBRA_SERVER_ADDRESS` overrides both.
pub async fn serve(bind: Option<String>) -> ServerResult<()> {
    let (providers_ready_tx, providers_ready) = watch::channel(false);

    let http_client = crate::http_client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(16)
        .tcp_keepalive(Duration::from_secs(30))
        .build()?;
    let media_cache = Arc::new(RwLock::new(MediaCache::default()));
    let tidal_cell = Arc::new(ProviderSlot::new());
    let qobuz_cell = Arc::new(ProviderSlot::new());
    let spotify_cell = Arc::new(SyncRwLock::new(None));
    let user_state = Arc::new(crate::user_state::UserState::new());
    let state = AppState {
        tidal: tidal_cell,
        qobuz: qobuz_cell,
        spotify: spotify_cell,
        spotify_login: Arc::new(Mutex::new(())),
        soloist: crate::soloist::Manager::new(),
        service_login: Arc::new(std::array::from_fn(|_| Mutex::new(()))),
        pending_tidal_login: Arc::new(Mutex::new(None)),
        pending_qobuz_login: Arc::new(Mutex::new(None)),
        artwork: Arc::new(crate::artwork_cache::ArtworkCache::with_disk(
            http_client.clone(),
            crate::storage::cache_subdirectory("artwork"),
        )),
        http_client,
        library_entries: Arc::new(RwLock::new(initial_library_entries())),
        search_cache: Arc::new(RwLock::new(HashMap::new())),
        catalog_cache: Arc::new(RwLock::new(HashMap::new())),
        search_fetches: Arc::new(Mutex::new(HashMap::new())),
        media_cache,
        providers_ready,
        media_fetches: Arc::new(Mutex::new(HashMap::new())),
        artwork_quality_cache: Arc::new(RwLock::new(HashMap::new())),
        artwork_dimensions_cache: Arc::new(RwLock::new(HashMap::new())),
        artist_metadata: Arc::new(Mutex::new(HashMap::new())),
        playlist_mutations: Arc::new(Mutex::new(HashMap::new())),
        discover: Arc::new(discover::Discover::default()),
        user_state: user_state.clone(),
    };

    let config = crate::server_config::ServerConfig::load();
    let address = match env::var("AMBRA_SERVER_ADDRESS").ok().or(bind) {
        Some(address) => crate::server_config::parse_bind(&address)?,
        None => config.address(),
    };
    let identity = ambra_net::Identity::load_or_create(&crate::storage::config_path("network-identity.key"))?;
    let network = crate::network::Network::with_identity(config, identity);
    let access = crate::access::AccessPolicy::from_env(network.clone());
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(access.origin_values()))
        .allow_methods([Method::GET, Method::HEAD, Method::POST])
        .allow_headers([RANGE, CONTENT_TYPE, AUTHORIZATION])
        .expose_headers([CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES, CONTENT_TYPE])
        .allow_private_network(true);

    // One store of shared state and one set of devices, for the routes and the core alike.
    let endpoints = Arc::new(crate::endpoints::Endpoints::default());
    let core = crate::session::Core::with_spotify(user_state.clone(), endpoints.clone(), Some(state.soloist.clone()));
    let app = Router::new()
        .merge(crate::network::public_router(network.clone()))
        .merge(crate::network::local_router(network.clone()))
        .merge(crate::endpoints::router(endpoints.clone()))
        .merge(crate::session::router(core.clone()))
        .merge(crate::soloist::router(state.soloist.clone()))
        .merge(crate::impulses::router())
        .merge(crate::remote::router())
        .merge(crate::local_music::router(user_state.clone()))
        .merge(crate::user_state::router(user_state.clone()))
        .route("/api/health", get(health))
        .route("/api/lyrics", get(lyrics))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/{provider}/start", post(start_auth))
        .route("/api/auth/{provider}/complete", post(complete_auth))
        .route("/api/auth/{provider}/disconnect", post(disconnect_auth))
        .route("/api/library", get(library))
        .route("/api/providers/{provider}/playlists", get(playlists::list))
        .route("/api/providers/{provider}/playlists/{playlist_id}", get(playlists::contents).post(playlists::change).delete(playlists::delete))
        .route("/api/library/tracks", post(add_track))
        .route("/api/library/tracks/remove", post(remove_tracks))
        .route("/api/recommendations/discover", get(discover::get))
        .route("/api/search/tracks", get(search_tracks))
        .route("/api/search/providers", get(search_providers))
        .route("/api/search/catalog", get(search_catalog))
        .route(
            "/api/providers/{provider}/albums/{album_id}/tracks",
            get(album_tracks),
        )
        .route(
            "/api/providers/{provider}/artists/{artist_id}/albums",
            get(artist_albums),
        )
        .route(
            "/api/providers/{provider}/artists/{artist_id}",
            get(artist_profile),
        )
        .route(
            "/api/providers/{provider}/artists/{artist_id}/metadata",
            get(artist_metadata),
        )
        .route(
            "/api/providers/{provider}/tracks/{track_id}/metadata",
            get(track_metadata),
        )
        .route(
            "/api/providers/{provider}/tracks/{track_id}/playback",
            get(track_playback),
        )
        .route(
            "/api/providers/{provider}/artists/{artist_id}/biography",
            get(credits::artist_biography),
        )
        .route("/api/credits/track", post(credits::track))
        .route("/api/credits/album", post(credits::album))
        .route("/api/quality/artwork", post(resolve_artwork_quality))
        .route("/api/artwork/thumbnail", get(artwork_thumbnail))
        .route("/api/artwork/palette", get(artwork_palette))
        .route("/api/library/albums", post(add_album))
        .route("/api/library/tidal-albums", post(add_tidal_album))
        .route("/api/library/qobuz-albums", post(add_qobuz_album))
        .route("/api/library/spotify-albums", post(add_spotify_album))
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
        .layer(middleware::from_fn_with_state(
            state.clone(),
            wait_for_providers,
        ))
        .layer(cors)
        // JSON only: shared state and queues shrink several times over, which matters on a
        // relayed connection (Tailscale away from home). Media keeps its byte ranges intact.
        .layer(CompressionLayer::new().gzip(true).compress_when(SizeAbove::new(1024).and(
            |_: axum::http::StatusCode, _: axum::http::Version, headers: &axum::http::HeaderMap, _: &axum::http::Extensions| {
                headers.get(CONTENT_TYPE).and_then(|value| value.to_str().ok()).is_some_and(|value| value.starts_with("application/json"))
            },
        )))
        // Outermost, so a foreign page is refused before CORS or provider waits.
        .layer(middleware::from_fn_with_state(
            access,
            crate::access::enforce,
        ))
        .with_state(state.clone());

    // Open the port first; provider sessions restore concurrently behind it.
    tokio::spawn(restore_providers(state.clone(), providers_ready_tx));

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| format!("Could not listen on {address}: {error}"))?;
    let address = listener.local_addr()?;
    crate::server_process::record(address).map_err(std::io::Error::other)?;
    if let Ok(mut listening) = network.listening.write() {
        *listening = Some(address);
    }
    if address.ip().is_loopback() {
        println!("Ambra server listening on http://{address} (this machine only)");
    } else {
        println!("Ambra server listening on http://{address} (shared with the local network)");
    }

    // Bound to one LAN address, the server also answers on loopback, so this machine's app and
    // the CLI keep their trusted local access.
    let loopback = (!address.ip().is_loopback() && !address.ip().is_unspecified())
        .then(|| std::net::SocketAddr::from(([127, 0, 0, 1], address.port())));
    let networking_cancel = tokio_util::sync::CancellationToken::new();
    let networking = tokio::spawn(crate::p2p::run(network.clone(), app.clone(), address, networking_cancel.clone()));
    let service = app.into_make_service_with_connect_info::<std::net::SocketAddr>();
    let serving = async { match loopback {
        Some(loopback) => {
            let local = tokio::net::TcpListener::bind(loopback)
                .await
                .map_err(|error| format!("Could not listen on {loopback}: {error}"))?;
            tokio::try_join!(
                axum::serve(listener, service.clone()).into_future(),
                axum::serve(local, service).into_future(),
            )?;
        }
        None => axum::serve(listener, service).await?,
    }
    Ok(()) };
    let result = tokio::select! {
        result = serving => { state.soloist.shutdown().await; result },
        _ = crate::server_process::stopped() => { core.save_transport(); state.soloist.shutdown().await; Ok(()) }
        _ = shutdown_signal() => { core.save_transport(); state.soloist.shutdown().await; Ok(()) }
    };
    networking_cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(4), networking).await;
    result
}

async fn shutdown_signal() {
    #[cfg(unix)] {
        if let Ok(mut terminate) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

async fn restore_providers(state: AppState, ready: watch::Sender<bool>) {
    let _login = (
        state.service_login[0].lock().await,
        state.service_login[1].lock().await,
        state.service_login[2].lock().await,
    );
    let started = Instant::now();
    let (tidal, qobuz, spotify) = tokio::join!(
        authenticate_tidal(),
        authenticate_qobuz(),
        authenticate_spotify(),
    );
    if let Ok(Some(mut provider)) = tidal {
        // Timing downloads and served segments share one bounded cache.
        provider.media_cache = state.media_cache.clone();
        let _ = state.tidal.set(provider);
    }
    if let Ok(Some(provider)) = qobuz {
        let _ = state.qobuz.set(provider);
    }
    if let Ok(Some(provider)) = spotify {
        state.soloist.set_account(Some(provider.account_id()));
        *state
            .spotify
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Some(provider);
    }
    let _ = ready.send(true);
    if env::var_os("AMBRA_PERF").is_some() {
        eprintln!(
            "[ambra:perf] providers restored in {} ms",
            started.elapsed().as_millis()
        );
    }
}

/// Routes that need no provider state answer immediately, even while saved
/// sessions are still being restored.
fn path_needs_providers(path: &str) -> bool {
    path != "/api/health"
        && path != "/api/state"
        && path != "/api/lyrics"
        && path != "/api/recommendations/discover"
        && !path.starts_with("/api/artwork/")
        // Pairing, settings and other devices' playback never involve a music service.
        && !path.starts_with("/api/server/")
        && !path.starts_with("/api/pair/")
        && !path.starts_with(crate::access::LOCAL_ONLY_PREFIX)
        && !path.starts_with("/api/endpoints")
        && !path.starts_with("/api/impulses/")
        && !path.starts_with("/api/session")
        && !path.starts_with("/api/spotify/playback/")
        && !path.starts_with("/api/playback/live/")
        && !path.starts_with("/api/music/local/")
        && !path.starts_with(crate::remote::PATH)
}

async fn lyrics(
    State(state): State<AppState>,
    Query(request): Query<crate::lyrics::LyricsRequest>,
) -> Response {
    let result = if let Err(message) = request.validate() {
        Err(ApiError::bad_request(message))
    } else {
        crate::lyrics::fetch(&state.http_client, &request)
            .await
            .map(Json)
            .map_err(ApiError::upstream)
    };
    let mut response = result.into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Wait for provider restoration. Returns `false` if it did not finish in time.
async fn providers_restored(mut ready: watch::Receiver<bool>, limit: Duration) -> bool {
    if *ready.borrow() {
        return true;
    }
    matches!(
        tokio::time::timeout(limit, ready.wait_for(|done| *done)).await,
        Ok(Ok(_))
    )
}

async fn wait_for_providers(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if request.method() != Method::OPTIONS
        && path_needs_providers(request.uri().path())
        && !providers_restored(state.providers_ready.clone(), PROVIDER_RESTORE_WAIT).await
    {
        return ApiError::service_unavailable("Music services are still starting").into_response();
    }
    next.run(request).await
}

async fn authenticate_tidal() -> ServerResult<Option<TidalProvider>> {
    match TidalProvider::authenticate_if_configured(false).await {
        Ok(Some(provider)) => return Ok(Some(provider)),
        Ok(None) => {}
        Err(error) => eprintln!("Tidal saved login failed: {error}"),
    }
    Ok(None)
}

async fn authenticate_qobuz() -> ServerResult<Option<QobuzProvider>> {
    match QobuzProvider::authenticate_if_configured(false).await {
        Ok(Some(provider)) => return Ok(Some(provider)),
        Ok(None) => {}
        Err(error) => eprintln!("Qobuz saved login failed: {error}"),
    }
    Ok(None)
}

async fn authenticate_spotify() -> ServerResult<Option<SpotifyProvider>> {
    match SpotifyProvider::authenticate_if_configured(false).await {
        Ok(Some(provider)) => return Ok(Some(provider)),
        Ok(None) => {}
        Err(error) => eprintln!("Spotify saved login failed: {error}"),
    }
    Ok(None)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatusResponse {
    tidal: bool,
    qobuz: bool,
    spotify: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStartResponse {
    status: &'static str,
    login_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteAuthRequest {
    callback_url: String,
}

#[derive(Deserialize)]
struct AuthStatusQuery {
    /// Asks Spotify whether the session still works, rather than trusting what's known.
    #[serde(default)]
    live: bool,
}

/// Apps poll this, so only Settings asks for the slower live check.
async fn auth_status(State(state): State<AppState>, Query(query): Query<AuthStatusQuery>) -> Json<AuthStatusResponse> {
    let spotify = match current_spotify(&state) {
        Some(provider) if query.live => tokio::time::timeout(Duration::from_secs(5), provider.check_connection())
            .await
            .unwrap_or_else(|_| provider.is_connected()),
        // A dropped session is replaced on the next request, so it's still signed in.
        Some(provider) => provider.is_connected() || provider.needs_reconnect(),
        None => false,
    };
    Json(AuthStatusResponse {
        tidal: state.tidal.get().is_some(),
        qobuz: state.qobuz.get().is_some(),
        spotify,
    })
}

async fn start_auth(
    State(state): State<AppState>,
    Path(provider): Path<String>,
) -> Result<Json<AuthStartResponse>, ApiError> {
    let _login = state.login_lock(&provider)?.lock().await;
    match provider.as_str() {
        "tidal" => {
            if state.tidal.get().is_some() {
                return Ok(Json(AuthStartResponse {
                    status: "connected",
                    login_url: None,
                }));
            }
            let (login, login_url) = TidalProvider::start_login().map_err(ApiError::upstream)?;
            *state.pending_tidal_login.lock().await = Some(login);
            Ok(Json(AuthStartResponse {
                status: "callbackRequired",
                login_url: Some(login_url),
            }))
        }
        "qobuz" => {
            if state.qobuz.get().is_some() {
                return Ok(Json(AuthStartResponse {
                    status: "connected",
                    login_url: None,
                }));
            }
            let (login, login_url) = QobuzProvider::start_login()
                .await
                .map_err(ApiError::upstream)?;
            *state.pending_qobuz_login.lock().await = Some(login);
            Ok(Json(AuthStartResponse {
                status: "callbackRequired",
                login_url: Some(login_url),
            }))
        }
        "spotify" => {
            // Only one OAuth listener may own the callback port at a time.
            let _login = state.spotify_login.lock().await;
            let connected = match current_spotify(&state) {
                Some(provider) => provider.check_connection().await,
                None => false,
            };
            if !connected {
                let was_disconnected = crate::service_auth::disconnected("spotify");
                let provider = SpotifyProvider::authenticate_if_configured(true)
                    .await;
                if provider.is_err() && was_disconnected {
                    crate::service_auth::set_disconnected("spotify", true).map_err(ApiError::internal)?;
                }
                let provider = provider.map_err(ApiError::upstream)?
                    .ok_or_else(|| {
                        ApiError::service_unavailable("Spotify login did not complete")
                    })?;
                state.discover.invalidate().await;
                state.soloist.set_account(Some(provider.account_id()));
                // Replace a revoked session. OnceLock prevented reconnecting a
                // service that had ever connected during this server lifetime.
                *state
                    .spotify
                    .write()
                    .unwrap_or_else(|error| error.into_inner()) = Some(provider);
                state
                    .search_cache
                    .write()
                    .await
                    .retain(|key, _| key.provider != MusicProvider::Spotify);
                state
                    .catalog_cache
                    .write()
                    .await
                    .retain(|key, _| key.provider != MusicProvider::Spotify);
            }
            Ok(Json(AuthStartResponse {
                status: "connected",
                login_url: None,
            }))
        }
        _ => Err(ApiError::not_found(format!(
            "Unknown music service '{provider}'"
        ))),
    }
}

async fn complete_auth(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    Json(request): Json<CompleteAuthRequest>,
) -> Result<Json<AuthStartResponse>, ApiError> {
    let _login = state.login_lock(&provider)?.lock().await;
    if request.callback_url.trim().is_empty() {
        return Err(ApiError::bad_request("Paste the full callback URL"));
    }
    match provider.as_str() {
        "tidal" => {
            let login = state
                .pending_tidal_login
                .lock()
                .await
                .take()
                .ok_or_else(|| ApiError::bad_request("Start Tidal sign-in before completing it"))?;
            let provider = TidalProvider::complete_login(login, &request.callback_url)
                .await
                .map_err(ApiError::upstream)?;
            let _ = state.tidal.set(provider);
        }
        "qobuz" => {
            let login = state
                .pending_qobuz_login
                .lock()
                .await
                .take()
                .ok_or_else(|| ApiError::bad_request("Start Qobuz sign-in before completing it"))?;
            let provider = QobuzProvider::complete_login(login, &request.callback_url)
                .await
                .map_err(ApiError::upstream)?;
            let _ = state.qobuz.set(provider);
        }
        "spotify" => {
            return Err(ApiError::bad_request(
                "Spotify completes sign-in automatically",
            ));
        }
        _ => {
            return Err(ApiError::not_found(format!(
                "Unknown music service '{provider}'"
            )));
        }
    }
    state.discover.invalidate().await;
    Ok(Json(AuthStartResponse {
        status: "connected",
        login_url: None,
    }))
}

async fn disconnect_auth(
    State(state): State<AppState>, Path(provider): Path<String>,
) -> Result<Json<AuthStatusResponse>, ApiError> {
    if !matches!(provider.as_str(), "tidal" | "qobuz" | "spotify") {
        return Err(ApiError::not_found("Unknown music service".into()));
    }
    let _login = state.login_lock(&provider)?.lock().await;
    let _spotify_login = if provider == "spotify" { Some(state.spotify_login.lock().await) } else { None };
    if provider == "tidal" { state.pending_tidal_login.lock().await.take(); }
    if provider == "qobuz" { state.pending_qobuz_login.lock().await.take(); }
    {
        let _credentials = crate::service_auth::credentials_guard();
        // Mark first: in-flight requests must not restore credentials after sign-out.
        crate::service_auth::set_disconnected(&provider, true).map_err(ApiError::internal)?;
        match provider.as_str() {
            "tidal" => {
                state.tidal.clear();
                crate::service_auth::remove(crate::storage::config_path("tidal-session.json")).map_err(ApiError::internal)?;
            }
            "qobuz" => {
                state.qobuz.clear();
                crate::service_auth::remove(crate::storage::config_path("qobuz-session.json")).map_err(ApiError::internal)?;
            }
            "spotify" => {
                if let Some(spotify) = state.spotify.write().unwrap_or_else(|e| e.into_inner()).take() {
                    spotify.disconnect();
                }
                for file in ["spotify/oauth.json", "spotify/credentials.json"] {
                    crate::service_auth::remove(crate::storage::config_path(file)).map_err(ApiError::internal)?;
                }
            }
            _ => unreachable!(),
        }
    }
    if provider == "spotify" { state.soloist.disconnect().await.map_err(ApiError::upstream)?; }
    state.search_cache.write().await.retain(|key, _| provider_slug(key.provider) != provider);
    state.catalog_cache.write().await.retain(|key, _| provider_slug(key.provider) != provider);
    *state.media_cache.write().await = MediaCache::default();
    state.discover.invalidate().await;
    Ok(Json(AuthStatusResponse {
        tidal: state.tidal.get().is_some(), qobuz: state.qobuz.get().is_some(),
        spotify: current_spotify(&state).is_some(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtworkQualityRequest {
    source_provider: MusicProvider,
    album_id: String,
    upc: Option<String>,
    cover_url: String,
}

async fn resolve_artwork_quality(
    State(state): State<AppState>,
    Json(request): Json<ArtworkQualityRequest>,
) -> Result<Json<ArtworkCandidate>, ApiError> {
    let provider = provider_slug(request.source_provider);
    if !trusted_artwork_url(provider, &request.cover_url) {
        return Err(ApiError::bad_request(
            "Artwork URL does not belong to the selected provider",
        ));
    }

    let cache_key = format!(
        "{provider}:{}:{}:{}",
        request.album_id,
        request.cover_url,
        request
            .upc
            .as_deref()
            .and_then(normalized_upc)
            .unwrap_or_default()
    );
    if let Some(cached) = state
        .artwork_quality_cache
        .write()
        .await
        .get_mut(&cache_key)
    {
        cached.0 = Instant::now();
        return Ok(Json(cached.1.clone()));
    }

    let upc = if request.upc.as_deref().is_some_and(|upc| !upc.is_empty()) {
        request.upc.clone()
    } else if request.source_provider == MusicProvider::Tidal {
        tidal_provider(&state)?
            .album_upc(&request.album_id)
            .await
            .map_err(ApiError::upstream)?
    } else {
        None
    };

    let alternative = async {
        let qobuz_url = if request.source_provider == MusicProvider::Qobuz {
            qobuz_max_artwork_url(&request.cover_url)
        } else if let (Some(qobuz), Some(upc)) = (state.qobuz.get(), upc.as_deref()) {
            qobuz
                .exact_album_artwork_by_upc(upc)
                .await
                .map_err(|_| ())?
        } else {
            None
        };
        let Some(url) = qobuz_url.filter(|url| url != &request.cover_url) else {
            return Ok::<_, ()>(None);
        };
        // An alternative that exists but can't be inspected is a failed lookup, not a miss.
        let (width, height) = cached_artwork_dimensions(&state, &url).await.ok_or(())?;
        Ok(Some(ArtworkCandidate {
            provider: "qobuz".to_owned(),
            url,
            width,
            height,
            colors: Vec::new(),
        }))
    };
    let (source_dimensions, qobuz) = tokio::join!(
        cached_artwork_dimensions(&state, &request.cover_url),
        alternative,
    );
    let complete = qobuz.is_ok();
    let qobuz = qobuz.ok().flatten();
    let source_dimensions = source_dimensions
        .ok_or_else(|| ApiError::upstream("Could not inspect source artwork dimensions"))?;
    let source = ArtworkCandidate {
        provider: provider.to_owned(),
        url: request.cover_url,
        width: source_dimensions.0,
        height: source_dimensions.1,
        colors: Vec::new(),
    };
    let best = highest_resolution(source, qobuz);

    // Remembering a lookup that failed would pin the smaller cover until the server restarts.
    if complete {
        let mut cache = state.artwork_quality_cache.write().await;
        if cache.len() >= 512 {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.0)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(cache_key, (Instant::now(), best.clone()));
    }
    Ok(Json(best))
}

#[derive(Deserialize)]
struct ArtworkQuery {
    provider: String,
    url: String,
    #[serde(default)]
    weighted: bool,
}

#[derive(Serialize)]
#[serde(untagged)]
enum ArtworkPaletteResponse {
    Colors(Vec<String>),
    Weighted(crate::artwork_quality::ArtworkPalette),
}

async fn artwork_thumbnail(
    State(state): State<AppState>,
    Query(query): Query<ArtworkQuery>,
) -> Result<Response, ApiError> {
    let artwork = state
        .artwork
        .get(&query.provider, &query.url)
        .await
        .map_err(ApiError::upstream)?;
    Response::builder()
        .header(CONTENT_TYPE, "image/jpeg")
        .header(CACHE_CONTROL, "public, max-age=604800")
        .body(Body::from(artwork.bytes.clone()))
        .map_err(ApiError::internal)
}

async fn artwork_palette(
    State(state): State<AppState>,
    Query(query): Query<ArtworkQuery>,
) -> Result<Json<ArtworkPaletteResponse>, ApiError> {
    let artwork = state
        .artwork
        .get(&query.provider, &query.url)
        .await
        .map_err(ApiError::upstream)?;
    Ok(Json(if query.weighted {
        ArtworkPaletteResponse::Weighted(artwork.palette().await)
    } else {
        ArtworkPaletteResponse::Colors(artwork.colors().await)
    }))
}

async fn cached_artwork_dimensions(state: &AppState, url: &str) -> Option<(u32, u32)> {
    if let Some(cached) = state.artwork_dimensions_cache.write().await.get_mut(url) {
        cached.0 = Instant::now();
        return Some(cached.1);
    }

    const IMAGE_HEADER_LIMIT: usize = 256 * 1024;
    let dimensions = async {
        let mut response = state
            .http_client
            .get(url)
            .header(RANGE, format!("bytes=0-{}", IMAGE_HEADER_LIMIT - 1))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }

        let mut header = Vec::with_capacity(64 * 1024);
        while header.len() < IMAGE_HEADER_LIMIT {
            let Some(chunk) = response.chunk().await.ok()? else {
                break;
            };
            let remaining = IMAGE_HEADER_LIMIT - header.len();
            header.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            if image_dimensions(&header).is_some() {
                break;
            }
        }
        image_dimensions(&header)
    }
    .await;

    if let Some(dimensions) = dimensions {
        let mut cache = state.artwork_dimensions_cache.write().await;
        if cache.len() >= 1024 {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.0)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(url.to_owned(), (Instant::now(), dimensions));
        return Some(dimensions);
    }
    None
}

async fn library(State(state): State<AppState>) -> Result<Json<LibraryResponse>, ApiError> {
    let entries = state.library_entries.read().await.clone();
    let disconnected = entries.iter().filter(|entry| !provider_is_configured(&state, entry.provider)).cloned().collect::<Vec<_>>();
    let available_entries = entries
        .into_iter()
        .filter(|entry| provider_is_configured(&state, entry.provider))
        .collect::<Vec<_>>();
    let (tracks, mut unavailable) =
        load_available_tracks(&state, &available_entries, LIBRARY_LOAD_CONCURRENCY).await;
    unavailable.extend(disconnected);

    Ok(Json(LibraryResponse {
        tracks,
        unavailable_track_ids: unavailable
            .iter()
            .map(|entry| {
                format!(
                    "{}:{}",
                    provider_slug(entry.provider),
                    entry.provider_track_id
                )
            })
            .collect(),
    }))
}

#[derive(Deserialize)]
struct SearchTracksRequest {
    provider: MusicProvider,
    query: String,
    #[serde(default)]
    offset: u32,
    limit: Option<u32>,
}

async fn search_request_lock(
    requests: &Mutex<HashMap<SearchCacheKey, Weak<Mutex<()>>>>,
    key: &SearchCacheKey,
) -> Arc<Mutex<()>> {
    let mut requests = requests.lock().await;
    requests.retain(|_, value| value.strong_count() > 0);
    if let Some(request) = requests.get(key).and_then(Weak::upgrade) {
        return request;
    }
    let request = Arc::new(Mutex::new(()));
    requests.insert(key.clone(), Arc::downgrade(&request));
    request
}

async fn search_providers(State(state): State<AppState>) -> Json<serde_json::Value> {
    let providers = [
        MusicProvider::Tidal,
        MusicProvider::Qobuz,
        MusicProvider::Spotify,
    ]
    .into_iter()
    .filter(|provider| provider_is_configured(&state, *provider))
    .collect::<Vec<_>>();
    Json(serde_json::json!({ "providers": providers }))
}

async fn search_catalog(
    State(state): State<AppState>,
    Query(request): Query<SearchTracksRequest>,
) -> Result<Json<crate::models::CatalogSearchPage>, ApiError> {
    use crate::models::{CatalogAlbum, CatalogArtist, CatalogSearchPage};
    let query = request.query.trim();
    if query.is_empty() {
        return Ok(Json(CatalogSearchPage::default()));
    }
    if query.chars().count() > 200 {
        return Err(ApiError::bad_request(
            "Search query cannot exceed 200 characters",
        ));
    }
    if !provider_is_configured(&state, request.provider) {
        return Err(ApiError::bad_request("Music provider is not configured"));
    }
    let limit = request.limit.unwrap_or(20).clamp(1, 20);
    let key = SearchCacheKey {
        provider: request.provider,
        query: format!("catalog:{}", query.to_lowercase()),
        offset: 0,
        limit,
    };
    let request_lock = search_request_lock(&state.search_fetches, &key).await;
    let _guard = request_lock.lock().await;
    if let Some((when, page)) = state.catalog_cache.read().await.get(&key) {
        if when.elapsed() < Duration::from_secs(300) {
            return Ok(Json(page.clone()));
        }
    }
    let fetch = async {
        match request.provider {
            MusicProvider::Tidal => tidal_provider(&state)?
                .search_catalog(query, limit)
                .await
                .map_err(ApiError::upstream),
            MusicProvider::Qobuz => qobuz_provider(&state)?
                .search_catalog(query, limit)
                .await
                .map_err(ApiError::upstream),
            MusicProvider::Spotify => {
                // Librespot exposes track search. Reuse returned metadata for entity cards
                // instead of introducing a separate Spotify developer-app requirement.
                let ids = spotify_provider(&state)
                    .await?
                    .search_track_ids(query, limit as usize, 0)
                    .await
                    .map_err(ApiError::upstream)?;
                let entries = ids
                    .into_iter()
                    .map(|provider_track_id| LibraryEntry {
                        provider: MusicProvider::Spotify,
                        provider_track_id,
                    })
                    .collect::<Vec<_>>();
                let tracks = load_search_tracks(&state, &entries).await;
                let artists = tracks
                    .iter()
                    .flat_map(|track| &track.artists)
                    .map(|artist| CatalogArtist {
                        id: format!("spotify:{}", artist.provider_id),
                        provider: MusicProvider::Spotify,
                        name: artist.name.clone(),
                        image_url: artist.image_url.clone(),
                    })
                    .collect();
                let albums = tracks
                    .iter()
                    .filter_map(|track| track.album.as_ref())
                    .map(|album| CatalogAlbum {
                        id: format!("spotify:{}", album.provider_id),
                        provider: MusicProvider::Spotify,
                        title: album.title.clone(),
                        artist: album
                            .artists
                            .iter()
                            .map(|artist| artist.name.clone())
                            .collect::<Vec<_>>()
                            .join(", "),
                        artists: album.artists.clone(),
                        image_url: album.cover_url.clone(),
                        upc: album.upc.clone(),
                        release_date: album.release_date.clone(),
                        release_type: None,
                        version: album.version.clone(),
                        explicit: None,
                        maximum_bit_depth: None,
                        maximum_sampling_rate_khz: None,
                    })
                    .collect();
                Ok(CatalogSearchPage {
                    tracks,
                    artists,
                    albums,
                })
            }
        }
    };
    let page = tokio::time::timeout(Duration::from_secs(7), fetch)
        .await
        .map_err(|_| ApiError::upstream(io::Error::other("Catalog search timed out")))??;
    let mut cache = state.catalog_cache.write().await;
    if cache.len() >= SEARCH_CACHE_LIMIT {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, (when, _))| when)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(key, (Instant::now(), page.clone()));
    Ok(Json(page))
}

async fn search_tracks(
    State(state): State<AppState>,
    Query(request): Query<SearchTracksRequest>,
) -> Result<Json<SearchPage>, ApiError> {
    let query = request.query.trim();
    if query.is_empty() {
        return Ok(Json(SearchPage {
            tracks: Vec::new(),
            next_offset: None,
        }));
    }
    if query.chars().count() > 200 {
        return Err(ApiError::bad_request(
            "Search query cannot exceed 200 characters",
        ));
    }
    if !provider_is_configured(&state, request.provider) {
        return Err(ApiError::bad_request("Music provider is not configured"));
    }
    let limit = request
        .limit
        .unwrap_or(DEFAULT_SEARCH_PAGE_SIZE)
        .clamp(1, MAX_SEARCH_PAGE_SIZE);
    let cache_key = SearchCacheKey {
        provider: request.provider,
        query: query.to_lowercase(),
        offset: request.offset,
        limit,
    };
    // Coalesce identical concurrent searches without binding one caller's cancellation
    // to another. Weak entries disappear once no active/waiting request needs the key.
    let request_lock = search_request_lock(&state.search_fetches, &cache_key).await;
    let _request_guard = request_lock.lock().await;
    if let Some(cached) = state.search_cache.read().await.get(&cache_key).cloned() {
        if cached.cached_at.elapsed() < Duration::from_secs(5 * 60) {
            return Ok(Json(cached.page));
        }
    }
    let fetch = async {
        match request.provider {
            MusicProvider::Tidal => tidal_provider(&state)?
                .search_tracks(query, limit, request.offset)
                .await
                .map_err(ApiError::upstream),
            MusicProvider::Qobuz => qobuz_provider(&state)?
                .search_tracks(query, limit, request.offset)
                .await
                .map_err(ApiError::upstream),
            MusicProvider::Spotify => {
                let mut ids = spotify_provider(&state)
                    .await?
                    .search_track_ids(query, limit as usize + 1, request.offset as usize)
                    .await
                    .map_err(ApiError::upstream)?;
                let next_offset =
                    (ids.len() > limit as usize).then_some(request.offset.saturating_add(limit));
                ids.truncate(limit as usize);
                let entries = ids
                    .into_iter()
                    .map(|provider_track_id| LibraryEntry {
                        provider: request.provider,
                        provider_track_id,
                    })
                    .collect::<Vec<_>>();
                Ok(SearchPage {
                    tracks: load_search_tracks(&state, &entries).await,
                    next_offset,
                })
            }
        }
    };
    let page = tokio::time::timeout(Duration::from_secs(7), fetch)
        .await
        .map_err(|_| ApiError::upstream(io::Error::other("Search timed out")))??;
    let mut cache = state.search_cache.write().await;
    if !cache.contains_key(&cache_key) && cache.len() >= SEARCH_CACHE_LIMIT {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, cached)| cached.cached_at)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        cache_key,
        CachedSearchPage {
            page: page.clone(),
            cached_at: Instant::now(),
        },
    );
    Ok(Json(page))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackPlaybackRequest {
    duration_seconds: Option<u64>,
}

async fn track_metadata(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
) -> Result<Json<TrackMetadata>, ApiError> {
    let provider = match provider.as_str() {
        "tidal" => MusicProvider::Tidal,
        "qobuz" => MusicProvider::Qobuz,
        "spotify" => MusicProvider::Spotify,
        _ => {
            return Err(ApiError::not_found(format!(
                "Music provider '{provider}' is not configured"
            )));
        }
    };
    if !provider_is_configured(&state, provider) {
        return Err(ApiError::bad_request("Music provider is not configured"));
    }
    let track = load_track(
        &state,
        &LibraryEntry {
            provider,
            provider_track_id: track_id,
        },
    )
    .await
    .map_err(ApiError::upstream)?;
    Ok(Json(track))
}

async fn track_playback(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
    Query(request): Query<TrackPlaybackRequest>,
) -> Result<Json<TrackPlaybackMetadata>, ApiError> {
    if provider != "tidal" {
        return Err(ApiError::bad_request(
            "Deferred playback inspection is only needed for Tidal",
        ));
    }
    if let Some(duration_seconds) = request
        .duration_seconds
        .filter(|duration| (1..=86_400).contains(duration))
    {
        tidal_provider(&state)?
            .playback_source_with_duration(&track_id, duration_seconds)
            .await
            .map_err(ApiError::upstream)?;
    } else {
        tidal_provider(&state)?
            .playback_source(&track_id)
            .await
            .map_err(ApiError::upstream)?;
    }
    let playback = tidal_provider(&state)?
        .playback_metadata(&track_id)
        .await
        .map_err(ApiError::upstream)?;

    Ok(Json(playback))
}

#[derive(Deserialize)]
struct AddAlbumRequest {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddTrackRequest {
    provider: MusicProvider,
    provider_track_id: String,
}

async fn add_track(
    State(state): State<AppState>,
    Json(request): Json<AddTrackRequest>,
) -> Result<Json<LibraryResponse>, ApiError> {
    if !provider_is_configured(&state, request.provider) {
        return Err(ApiError::bad_request("Music provider is not configured"));
    }

    let entry = LibraryEntry {
        provider: request.provider,
        provider_track_id: request.provider_track_id,
    };
    let tracks = load_tracks(&state, std::slice::from_ref(&entry)).await?;

    let mut library_entries = state.library_entries.write().await;
    if !library_entries.contains(&entry) {
        library_entries.push(entry);
        if let Err(error) = save_library_entries(&library_entries) {
            eprintln!("Could not persist the streaming library cache: {error}");
        }
    }

    Ok(Json(LibraryResponse::new(tracks)))
}

#[derive(Deserialize)]
struct RemoveTracksRequest {
    tracks: Vec<LibraryEntry>,
}

async fn remove_tracks(
    State(state): State<AppState>,
    Json(request): Json<RemoveTracksRequest>,
) -> Result<StatusCode, ApiError> {
    let removed = request.tracks.into_iter().collect::<HashSet<_>>();
    let mut library_entries = state.library_entries.write().await;
    let before = library_entries.len();
    library_entries.retain(|entry| !removed.contains(entry));
    if library_entries.len() != before {
        save_library_entries(&library_entries).map_err(ApiError::internal)?;
    }
    Ok(StatusCode::NO_CONTENT)
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
    if let Some(album_id) = spotify_album_id(&request.url) {
        return import_album(&state, MusicProvider::Spotify, album_id).await;
    }
    Err(ApiError::bad_request(
        "Unsupported album link; paste a Tidal, Qobuz, or Spotify album URL",
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

async fn add_spotify_album(
    State(state): State<AppState>,
    Json(request): Json<AddAlbumRequest>,
) -> Result<Json<LibraryResponse>, ApiError> {
    let album_id = spotify_album_id(&request.url)
        .ok_or_else(|| ApiError::bad_request("Invalid Spotify album link"))?;
    import_album(&state, MusicProvider::Spotify, album_id).await
}

#[derive(Deserialize)]
struct CatalogPageRequest {
    #[serde(default)]
    offset: u32,
    limit: Option<u32>,
}

// Cache profile data separately from popular-track hydration.
async fn cached_artist_metadata(
    state: &AppState,
    provider: MusicProvider,
    artist_id: &str,
) -> Result<crate::models::ArtistProfileMetadata, ApiError> {
    let cell = {
        let mut cache = state.artist_metadata.lock().await;
        cache.retain(|_, (when, _)| when.elapsed() < Duration::from_secs(3600));
        let key = (provider, artist_id.to_owned());
        if !cache.contains_key(&key) && cache.len() >= 256 {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (when, _))| *when)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache
            .entry(key)
            .or_insert_with(|| (Instant::now(), Arc::new(tokio::sync::OnceCell::new())))
            .1
            .clone()
    };
    let fetch = async {
        match provider {
            MusicProvider::Tidal => tidal_provider(state)?
                .artist_profile(artist_id)
                .await
                .map_err(ApiError::upstream),
            MusicProvider::Qobuz => qobuz_provider(state)?
                .artist_profile(artist_id)
                .await
                .map_err(ApiError::upstream),
            MusicProvider::Spotify => spotify_provider(state)
                .await?
                .artist_profile(artist_id)
                .await
                .map_err(ApiError::upstream),
        }
    };
    let profile = cell
        .get_or_try_init(|| async {
            tokio::time::timeout(Duration::from_secs(30), fetch)
                .await
                .map_err(|_| ApiError::upstream(io::Error::other("Artist profile timed out")))?
        })
        .await
        .cloned()?;
    if profile.popular_tracks_error.is_some() {
        state
            .artist_metadata
            .lock()
            .await
            .remove(&(provider, artist_id.to_owned()));
    }
    Ok(profile)
}

async fn artist_metadata(
    State(state): State<AppState>,
    Path((provider, artist_id)): Path<(MusicProvider, String)>,
) -> Result<Json<crate::models::CatalogArtist>, ApiError> {
    let cached = state
        .artist_metadata
        .lock()
        .await
        .get(&(provider, artist_id.clone()))
        .filter(|(when, _)| when.elapsed() < Duration::from_secs(3600))
        .and_then(|(_, cell)| cell.get().map(|profile| profile.artist.clone()));
    if let Some(artist) = cached {
        return Ok(Json(artist));
    }
    // A library portrait must not wait for biography or popular-track requests.
    let fetch = async {
        match provider {
            MusicProvider::Tidal => tidal_provider(&state)?.artist_details(&artist_id).await,
            MusicProvider::Qobuz => qobuz_provider(&state)?.artist_details(&artist_id).await,
            MusicProvider::Spotify => spotify_provider(&state)
                .await?
                .artist_details(&artist_id)
                .await,
        }
        .map_err(ApiError::upstream)
    };
    Ok(Json(
        tokio::time::timeout(Duration::from_secs(15), fetch)
            .await
            .map_err(|_| ApiError::upstream(io::Error::other("Artist portrait timed out")))??,
    ))
}

async fn artist_profile(
    State(state): State<AppState>,
    Path((provider, artist_id)): Path<(MusicProvider, String)>,
) -> Result<Json<crate::models::CatalogArtistProfile>, ApiError> {
    use crate::models::CatalogArtistProfile;
    let profile = cached_artist_metadata(&state, provider, &artist_id).await?;
    let entries: Vec<_> = profile
        .popular_track_ids
        .into_iter()
        .map(|provider_track_id| LibraryEntry {
            provider,
            provider_track_id,
        })
        .collect();
    let popular_tracks = load_search_tracks(&state, &entries).await;
    let popular_tracks_error = profile.popular_tracks_error.or_else(|| {
        (!entries.is_empty() && popular_tracks.is_empty())
            .then(|| "Popular tracks couldn't be loaded.".to_owned())
    });
    Ok(Json(CatalogArtistProfile {
        artist: profile.artist,
        biography: profile.biography,
        biography_source: profile.biography_source,
        popular_tracks,
        popular_tracks_error,
    }))
}

async fn artist_albums(
    State(state): State<AppState>,
    Path((provider, artist_id)): Path<(MusicProvider, String)>,
    Query(request): Query<CatalogPageRequest>,
) -> Result<Json<crate::models::CatalogAlbumsPage>, ApiError> {
    let limit = request.limit.unwrap_or(30).clamp(1, 50);
    let fetch = async {
        match provider {
            MusicProvider::Tidal => tidal_provider(&state)?
                .artist_albums(&artist_id, request.offset, limit)
                .await
                .map_err(ApiError::upstream),
            MusicProvider::Qobuz => qobuz_provider(&state)?
                .artist_albums(&artist_id, request.offset, limit)
                .await
                .map_err(ApiError::upstream),
            MusicProvider::Spotify => spotify_provider(&state)
                .await?
                .artist_albums(&artist_id, request.offset, limit)
                .await
                .map_err(ApiError::upstream),
        }
    };
    Ok(Json(
        tokio::time::timeout(Duration::from_secs(30), fetch)
            .await
            .map_err(|_| ApiError::upstream(io::Error::other("Artist albums timed out")))??,
    ))
}

// Browsing must never import music or change saved library membership.
async fn album_tracks(
    State(state): State<AppState>,
    Path((provider, album_id)): Path<(MusicProvider, String)>,
) -> Result<Json<LibraryResponse>, ApiError> {
    let results = match provider {
        MusicProvider::Tidal => tidal_provider(&state)?
            .album_tracks(&album_id, ALBUM_LOAD_CONCURRENCY)
            .await
            .map_err(ApiError::upstream)?,
        MusicProvider::Qobuz => qobuz_provider(&state)?
            .album_tracks(&album_id, ALBUM_LOAD_CONCURRENCY)
            .await
            .map_err(ApiError::upstream)?,
        // Spotify albums only list track IDs, so each track loads on its own.
        MusicProvider::Spotify => {
            let entries = album_entries(&state, provider, &album_id).await?;
            let (tracks, _) = load_available_tracks(&state, &entries, ALBUM_LOAD_CONCURRENCY).await;
            if tracks.is_empty() {
                return Err(ApiError::upstream(io::Error::other(format!(
                    "No tracks on {} album {album_id} could be loaded",
                    provider_name(provider)
                ))));
            }
            return Ok(Json(LibraryResponse::new(tracks)));
        }
    };
    let mut tracks = Vec::with_capacity(results.len());
    for (track_id, result) in results {
        match result {
            Ok(track) => tracks.push(track),
            Err(error) => eprintln!(
                "Could not load {} track {track_id}: {error}",
                provider_name(provider)
            ),
        }
    }
    if tracks.is_empty() {
        return Err(ApiError::upstream(io::Error::other(format!(
            "No tracks on {} album {album_id} could be loaded",
            provider_name(provider)
        ))));
    }
    Ok(Json(LibraryResponse::new(tracks)))
}

async fn album_entries(
    state: &AppState,
    provider: MusicProvider,
    album_id: &str,
) -> Result<Vec<LibraryEntry>, ApiError> {
    let track_ids = match provider {
        MusicProvider::Tidal => tidal_provider(state)?
            .album_track_ids(album_id)
            .await
            .map_err(ApiError::upstream)?,
        MusicProvider::Qobuz => qobuz_provider(state)?
            .album_track_ids(album_id)
            .await
            .map_err(ApiError::upstream)?,
        MusicProvider::Spotify => spotify_provider(state)
            .await?
            .album_track_ids(album_id)
            .await
            .map_err(ApiError::upstream)?,
    };
    if track_ids.is_empty() {
        return Err(ApiError::not_found(format!(
            "{} album {album_id} contains no tracks",
            provider_name(provider)
        )));
    }
    Ok(track_ids
        .into_iter()
        .map(|provider_track_id| LibraryEntry {
            provider,
            provider_track_id,
        })
        .collect())
}

async fn import_album(
    state: &AppState,
    provider: MusicProvider,
    album_id: String,
) -> Result<Json<LibraryResponse>, ApiError> {
    let entries = album_entries(state, provider, &album_id).await?;
    // Region-locked or pulled tracks are skipped instead of failing the album.
    let (tracks, unavailable) =
        load_available_tracks(state, &entries, LIBRARY_LOAD_CONCURRENCY).await;
    if tracks.is_empty() {
        return Err(ApiError::upstream(io::Error::other(format!(
            "No tracks on {} album {album_id} could be loaded",
            provider_name(provider)
        ))));
    }
    let unavailable = unavailable.into_iter().collect::<HashSet<_>>();
    let entries = entries
        .into_iter()
        .filter(|entry| !unavailable.contains(entry))
        .collect();

    let mut library_entries = state.library_entries.write().await;
    move_entries_to_end(&mut library_entries, entries);
    if let Err(error) = save_library_entries(&library_entries) {
        eprintln!("Could not persist the streaming library cache: {error}");
    }

    Ok(Json(LibraryResponse::new(tracks)))
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

/// Loads what it can, in order; one pulled or region-locked track must not hide
/// the rest. Returns the entries that failed alongside the loaded tracks.
// Whole-library loads stay gentle on provider rate limits. An open album page is
// small and someone is waiting on it, so its uncached tracks load more widely.
const LIBRARY_LOAD_CONCURRENCY: usize = 4;
const ALBUM_LOAD_CONCURRENCY: usize = 12;

async fn load_available_tracks(
    state: &AppState,
    entries: &[LibraryEntry],
    concurrency: usize,
) -> (Vec<TrackMetadata>, Vec<LibraryEntry>) {
    let results = stream::iter(entries.iter().cloned())
        .map(|entry| {
            let state = state.clone();
            async move {
                let result = load_track(&state, &entry).await;
                (entry, result)
            }
        })
        .buffered(concurrency)
        .collect::<Vec<_>>()
        .await;
    let mut tracks = Vec::with_capacity(results.len());
    let mut failed = Vec::new();
    for (entry, result) in results {
        match result {
            Ok(track) => tracks.push(track),
            Err(error) => {
                eprintln!(
                    "Could not load {} track {}: {error}",
                    provider_name(entry.provider),
                    entry.provider_track_id
                );
                failed.push(entry);
            }
        }
    }
    (tracks, failed)
}

async fn load_search_tracks(state: &AppState, entries: &[LibraryEntry]) -> Vec<TrackMetadata> {
    let mut tracks = stream::iter(entries.iter().cloned().enumerate())
        .map(|(index, entry)| {
            let state = state.clone();
            async move {
                let result =
                    tokio::time::timeout(SEARCH_METADATA_TIMEOUT, load_track(&state, &entry)).await;
                (index, entry, result)
            }
        })
        .buffer_unordered(8)
        .filter_map(|(index, entry, result)| async move {
            match result {
                Ok(Ok(track)) => Some((index, track)),
                Ok(Err(error)) => {
                    eprintln!(
                        "Could not load {} search result {}: {error}",
                        provider_name(entry.provider),
                        entry.provider_track_id
                    );
                    None
                }
                Err(_) => {
                    eprintln!(
                        "Timed out loading {} search result {}",
                        provider_name(entry.provider),
                        entry.provider_track_id
                    );
                    None
                }
            }
        })
        .collect::<Vec<_>>()
        .await;
    tracks.sort_by_key(|(index, _)| *index);
    tracks.into_iter().map(|(_, track)| track).collect()
}

async fn load_track(state: &AppState, entry: &LibraryEntry) -> ServerResult<TrackMetadata> {
    match entry.provider {
        MusicProvider::Tidal => {
            state
                .tidal
                .get()
                .ok_or_else(|| io::Error::other("Tidal login is not configured"))?
                .track_metadata(&entry.provider_track_id)
                .await
        }
        MusicProvider::Qobuz => {
            state
                .qobuz
                .get()
                .ok_or_else(|| io::Error::other("Qobuz login is not configured"))?
                .track_metadata(&entry.provider_track_id)
                .await
        }
        MusicProvider::Spotify => {
            spotify_provider(state)
                .await
                .map_err(|error| io::Error::other(error.message))?
                .track_metadata(&entry.provider_track_id)
                .await
        }
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
    crate::storage::data_path("streaming-library.json")
}

fn legacy_library_track_ids_path() -> PathBuf {
    crate::storage::data_path("library-track-ids.json")
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

fn spotify_album_id(link: &str) -> Option<String> {
    let link = link.trim();
    if let Some(album_id) = link.strip_prefix("spotify:album:") {
        return valid_spotify_id(album_id).then(|| album_id.to_owned());
    }

    let without_scheme = link
        .strip_prefix("https://")
        .or_else(|| link.strip_prefix("http://"))?;
    let (host, path) = without_scheme.split_once('/')?;
    let host = host.split(':').next()?.to_ascii_lowercase();
    if !matches!(host.as_str(), "open.spotify.com" | "play.spotify.com") {
        return None;
    }

    let clean_path = path.split(['?', '#']).next()?;
    let segments = clean_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let album_id = segments
        .windows(2)
        .find(|segments| segments[0] == "album")?
        .get(1)?;
    valid_spotify_id(album_id).then(|| (*album_id).to_owned())
}

fn valid_spotify_id(id: &str) -> bool {
    id.len() == 22
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

async fn stream_track(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    match provider.as_str() {
        "tidal" => {
            let source = tidal_provider(&state)?
                .playback_source(&track_id)
                .await
                .map_err(ApiError::upstream)?;
            match source {
                PlaybackSource::Direct { url, mime_type } => {
                    let mut response =
                        proxy_direct_stream(&state.http_client, &url, &mime_type, &headers)
                            .await?;
                    tidal_provider(&state)?
                        .loudness(&track_id)
                        .await
                        .insert_into(response.headers_mut());
                    Ok(response)
                }
                PlaybackSource::Dash { .. } => Err(ApiError::not_found(format!(
                    "Tidal track {track_id} uses its DASH manifest endpoint"
                ))),
            }
        }
        "qobuz" => {
            let provider = qobuz_provider(&state)?;
            let source = provider
                .playback_source(&track_id)
                .await
                .map_err(ApiError::upstream)?;
            // Only the opening request needs the loudness; it is looked up while the audio starts.
            let opening = headers
                .get(RANGE)
                .and_then(|range| range.to_str().ok())
                .is_none_or(|range| range.starts_with("bytes=0-"));
            let (response, loudness) = tokio::join!(
                proxy_direct_stream(&state.http_client, &source.url, &source.mime_type, &headers),
                async {
                    if opening {
                        provider.loudness(&track_id).await
                    } else {
                        Loudness::default()
                    }
                }
            );
            let mut response = response?;
            loudness.insert_into(response.headers_mut());
            Ok(response)
        }
        "spotify" => stream_spotify_track(&state, &track_id, &headers).await,
        _ => Err(ApiError::not_found(format!(
            "Music provider '{provider}' is not configured"
        ))),
    }
}

async fn stream_spotify_track(
    state: &AppState,
    track_id: &str,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let mut prepared = spotify_provider(state)
        .await?
        .prepare_stream(track_id)
        .await
        .map_err(ApiError::upstream)?;
    let total_length = prepared.content_length();
    let (start, end_inclusive, partial) = requested_byte_range(headers.get(RANGE), total_length)?;
    // The player reads the loudness from its opening request; the header is downloaded first anyway.
    let loudness = if start == 0 {
        let (returned, loudness) = tokio::task::spawn_blocking(move || {
            let loudness = prepared.read_loudness();
            (prepared, loudness)
        })
        .await
        .map_err(ApiError::internal)?;
        prepared = returned;
        loudness
    } else {
        Loudness::default()
    };
    let response_length = end_inclusive.saturating_sub(start).saturating_add(1);
    let mime_type = prepared.mime_type();
    let stream = ReceiverStream::new(prepared.into_byte_stream(start, end_inclusive));

    let mut response = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(CONTENT_TYPE, mime_type)
        .header(CONTENT_LENGTH, response_length)
        .header(ACCEPT_RANGES, "bytes")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream))
        .map_err(ApiError::internal)?;
    if partial {
        response.headers_mut().insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end_inclusive}/{total_length}"))
                .map_err(ApiError::internal)?,
        );
    }
    loudness.insert_into(response.headers_mut());
    Ok(response)
}

fn requested_byte_range(
    header: Option<&HeaderValue>,
    total_length: u64,
) -> Result<(u64, u64, bool), ApiError> {
    if total_length == 0 {
        return Err(ApiError::range_not_satisfiable(total_length));
    }
    let Some(header) = header else {
        return Ok((0, total_length - 1, false));
    };
    let value = header
        .to_str()
        .map_err(|_| ApiError::range_not_satisfiable(total_length))?;
    let range = value
        .strip_prefix("bytes=")
        .filter(|range| !range.contains(','))
        .ok_or_else(|| ApiError::range_not_satisfiable(total_length))?;
    let (start, end) = range
        .split_once('-')
        .ok_or_else(|| ApiError::range_not_satisfiable(total_length))?;

    let (start, end_inclusive) = if start.is_empty() {
        let suffix_length = end
            .parse::<u64>()
            .ok()
            .filter(|length| *length > 0)
            .ok_or_else(|| ApiError::range_not_satisfiable(total_length))?;
        (total_length.saturating_sub(suffix_length), total_length - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| ApiError::range_not_satisfiable(total_length))?;
        if start >= total_length {
            return Err(ApiError::range_not_satisfiable(total_length));
        }
        let end_inclusive = if end.is_empty() {
            total_length - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| ApiError::range_not_satisfiable(total_length))?
                .min(total_length - 1)
        };
        (start, end_inclusive)
    };

    if end_inclusive < start {
        return Err(ApiError::range_not_satisfiable(total_length));
    }
    Ok((start, end_inclusive, true))
}

async fn dash_manifest(
    State(state): State<AppState>,
    Path((provider, track_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    ensure_tidal_provider(&provider)?;

    let source = tidal_provider(&state)?
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
    access: Option<Extension<crate::access::MediaAccessToken>>,
) -> Result<Response, ApiError> {
    ensure_tidal_provider(&provider)?;

    let source = tidal_provider(&state)?
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
        access.as_ref().map(|Extension(token)| token.0.as_str()),
    )?;

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/vnd.apple.mpegurl")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(playlist))
        .map_err(ApiError::internal)?;
    tidal_provider(&state)?
        .loudness(&track_id)
        .await
        .insert_into(response.headers_mut());
    Ok(response)
}

fn hls_playlist_body(
    timescale: u32,
    segment_duration: u32,
    start_number: u32,
    segment_count: u32,
    track_duration_seconds: f64,
    access_token: Option<&str>,
) -> Result<String, ApiError> {
    if timescale == 0 || segment_duration == 0 || segment_count == 0 {
        return Err(ApiError::internal("Invalid segmented audio timing"));
    }

    let nominal_duration = f64::from(segment_duration) / f64::from(timescale);
    let target_duration = nominal_duration.ceil().max(1.0) as u64;
    let mut remaining = track_duration_seconds;
    let authentication = access_token.map_or_else(String::new, |token| {
        format!("?{}={}", crate::access::TOKEN_PARAMETER, urlencoding::encode(token))
    });
    let mut playlist = format!(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:{target_duration}\n#EXT-X-MEDIA-SEQUENCE:{start_number}\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"dash/init{authentication}\"\n"
    );

    for offset in 0..segment_count {
        let duration = remaining.min(nominal_duration).max(0.001);
        let segment_number = start_number.saturating_add(offset);
        playlist.push_str(&format!("#EXTINF:{duration:.6},\ndash/{segment_number}{authentication}\n"));
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

    let source = tidal_provider(&state)?
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

    cached_media_response(&state, &initialization_url, &mime_type).await
}

async fn dash_segment(
    State(state): State<AppState>,
    Path((provider, track_id, segment_number)): Path<(String, String, u32)>,
) -> Result<Response, ApiError> {
    ensure_tidal_provider(&provider)?;

    let source = tidal_provider(&state)?
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
    let response = cached_media_response(&state, &segment_url, &mime_type).await?;

    let next_number = segment_number.saturating_add(1);
    let has_next = segment_count
        .map(|count| next_number < start_number.saturating_add(count))
        .unwrap_or(true);
    if has_next {
        let state = state.clone();
        let next_url = media_url_template.replace("$Number$", &next_number.to_string());
        tokio::spawn(async move {
            let _ = cached_media_bytes(&state, &next_url).await;
        });
    }
    Ok(response)
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

fn tidal_provider(state: &AppState) -> Result<TidalProvider, ApiError> {
    state.tidal.get().ok_or_else(|| {
        ApiError::service_unavailable(
            "Tidal is not connected. Sign in from Settings → Services.",
        )
    })
}

fn qobuz_provider(state: &AppState) -> Result<QobuzProvider, ApiError> {
    state.qobuz.get().ok_or_else(|| {
        ApiError::service_unavailable(
            "Qobuz is not connected. Sign in from Settings → Services.",
        )
    })
}

fn current_spotify(state: &AppState) -> Option<SpotifyProvider> {
    state
        .spotify
        .read()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}

async fn spotify_provider(state: &AppState) -> Result<SpotifyProvider, ApiError> {
    let unavailable = || {
        ApiError::service_unavailable(
            "Spotify is not connected. Sign in from Settings → Services.",
        )
    };
    let provider = current_spotify(state).ok_or_else(unavailable)?;
    if !provider.needs_reconnect() {
        return Ok(provider);
    }

    // Librespot sessions cannot be reused after a dropped connection. Serialize
    // replacement with interactive sign-in so concurrent requests share it.
    let _login = state.spotify_login.lock().await;
    let provider = current_spotify(state).ok_or_else(unavailable)?;
    if !provider.needs_reconnect() {
        return Ok(provider);
    }
    let provider = SpotifyProvider::authenticate_if_configured(false)
        .await
        .map_err(ApiError::upstream)?
        .ok_or_else(unavailable)?;
    *state
        .spotify
        .write()
        .unwrap_or_else(|error| error.into_inner()) = Some(provider.clone());
    Ok(provider)
}

fn provider_is_configured(state: &AppState, provider: MusicProvider) -> bool {
    match provider {
        MusicProvider::Tidal => state.tidal.get().is_some(),
        MusicProvider::Qobuz => state.qobuz.get().is_some(),
        MusicProvider::Spotify => current_spotify(state).is_some(),
    }
}

fn provider_name(provider: MusicProvider) -> &'static str {
    match provider {
        MusicProvider::Tidal => "Tidal",
        MusicProvider::Qobuz => "Qobuz",
        MusicProvider::Spotify => "Spotify",
    }
}

fn provider_slug(provider: MusicProvider) -> &'static str {
    match provider {
        MusicProvider::Tidal => "tidal",
        MusicProvider::Qobuz => "qobuz",
        MusicProvider::Spotify => "spotify",
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

async fn cached_media_response(
    state: &AppState,
    url: &str,
    fallback_mime_type: &str,
) -> Result<Response, ApiError> {
    let bytes = cached_media_bytes(state, url).await?;
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, fallback_mime_type)
        .header(CONTENT_LENGTH, bytes.len())
        .header(CACHE_CONTROL, "private, max-age=3600")
        .body(Body::from(bytes))
        .map_err(ApiError::internal)
}

async fn cached_media_bytes(state: &AppState, url: &str) -> Result<Bytes, ApiError> {
    if let Some(bytes) = state.media_cache.write().await.get(url) {
        return Ok(bytes);
    }

    let fetch_lock = {
        let mut fetches = state.media_fetches.lock().await;
        fetches.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = fetches.get(url).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(Mutex::new(()));
            fetches.insert(url.to_owned(), Arc::downgrade(&lock));
            lock
        }
    };
    let _fetch_guard = fetch_lock.lock().await;
    if let Some(bytes) = state.media_cache.write().await.get(url) {
        return Ok(bytes);
    }

    let result = download_media_bytes(&state.http_client, url).await;
    if let Ok(bytes) = &result {
        state
            .media_cache
            .write()
            .await
            .insert(url.to_owned(), bytes.clone());
    }
    let bytes = result?;
    if let Some(cached) = state.media_cache.write().await.get(url) {
        return Ok(cached);
    }
    Ok(bytes)
}

async fn download_media_bytes(client: &reqwest::Client, url: &str) -> Result<Bytes, ApiError> {
    let mut last_error = None;
    for attempt in 0..UPSTREAM_ATTEMPTS {
        match client.get(url).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => match response.bytes().await {
                    Ok(bytes) => return Ok(bytes),
                    Err(error) => last_error = Some(error.to_string()),
                },
                Err(error) => last_error = Some(error.to_string()),
            },
            Err(error) => last_error = Some(error.to_string()),
        }
        if attempt + 1 < UPSTREAM_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(100 * (1_u64 << attempt))).await;
        }
    }
    Err(ApiError::upstream(io::Error::other(format!(
        "Media request failed after {UPSTREAM_ATTEMPTS} attempts: {}",
        last_error.unwrap_or_else(|| "unknown error".to_owned())
    ))))
}

fn copy_header(source: &HeaderMap, destination: &mut HeaderMap, name: axum::http::HeaderName) {
    if let Some(value) = source.get(&name) {
        destination.insert(name, value.clone());
    }
}

fn configured_tidal_track_ids() -> Vec<String> {
    env::var("AMBRA_TIDAL_TRACK_IDS")
        .map(|value| parse_configured_tidal_track_ids(&value))
        .unwrap_or_default()
}

fn parse_configured_tidal_track_ids(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
    content_range: Option<String>,
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
            content_range: None,
        }
    }

    fn not_found(message: String) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message,
            content_range: None,
        }
    }

    fn upstream(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: error.to_string(),
            content_range: None,
        }
    }

    fn service_unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
            content_range: None,
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
            content_range: None,
        }
    }

    fn range_not_satisfiable(total_length: u64) -> Self {
        Self {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: "Requested audio byte range is not satisfiable".to_owned(),
            content_range: Some(format!("bytes */{total_length}")),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let content_range = self.content_range;
        let mut response = (
            self.status,
            Json(ErrorResponse {
                error: self.message,
            }),
        )
            .into_response();
        if let Some(content_range) = content_range
            && let Ok(value) = HeaderValue::from_str(&content_range)
        {
            response.headers_mut().insert(CONTENT_RANGE, value);
        }
        response
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn provider_slots_can_disconnect_and_reconnect_without_a_server_restart() {
        let slot = super::ProviderSlot::new();
        assert!(slot.get().is_none());
        slot.set("first session".to_owned());
        let old_request = slot.get();
        slot.clear();
        assert!(slot.get().is_none());
        slot.set("replacement session".to_owned());
        assert_eq!(slot.get().as_deref(), Some("replacement session"));
        assert_eq!(old_request.as_deref(), Some("first session"));
    }
    use super::{
        LibraryEntry, hls_playlist_body, move_entries_to_end, parse_configured_tidal_track_ids,
        qobuz_album_id, requested_byte_range, spotify_album_id, tidal_album_id,
    };
    use crate::models::MusicProvider;
    use axum::http::HeaderValue;

    #[tokio::test]
    async fn proxies_audio_with_many_upstream_headers() {
        use axum::{
            body::to_bytes,
            http::{HeaderMap, StatusCode, header::*},
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for header_count in [101, 300, 1024] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/audio", listener.local_addr().unwrap());
            let (finished, done) = tokio::sync::oneshot::channel::<()>();
            let upstream = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.ends_with(b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                assert!(
                    String::from_utf8(request)
                        .unwrap()
                        .to_ascii_lowercase()
                        .contains("range: bytes=5-8\r\n")
                );

                let mut response = String::from(
                    "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/flac\r\nContent-Length: 4\r\nContent-Range: bytes 5-8/12\r\nAccept-Ranges: bytes\r\nETag: \"audio\"\r\nLast-Modified: Fri, 09 Oct 2026 12:00:00 GMT\r\nConnection: close\r\n",
                );
                // Repeated CDN diagnostics count individually toward the parser limit.
                for _ in 7..header_count {
                    response.push_str("X-AK-GRN: 0\r\n");
                }
                response.push_str("\r\nFLAC");
                socket.write_all(response.as_bytes()).await.unwrap();
                // Held open until the client has its response: on Windows, closing first can reach
                // the client as a reset before it reads the response.
                let _ = done.await;
            });

            let mut headers = HeaderMap::new();
            headers.insert(RANGE, HeaderValue::from_static("bytes=5-8"));
            let response = super::proxy_direct_stream(
                &crate::http_client::builder().build().unwrap(),
                &url,
                "application/octet-stream",
                &headers,
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.headers()[CONTENT_TYPE], "audio/flac");
            assert_eq!(response.headers()[CONTENT_LENGTH], "4");
            assert_eq!(response.headers()[CONTENT_RANGE], "bytes 5-8/12");
            assert_eq!(response.headers()[ACCEPT_RANGES], "bytes");
            assert_eq!(response.headers()[ETAG], "\"audio\"");
            assert_eq!(
                response.headers()[LAST_MODIFIED],
                "Fri, 09 Oct 2026 12:00:00 GMT"
            );
            assert!(!response.headers().contains_key("x-ak-grn"));
            assert_eq!(
                to_bytes(response.into_body(), 4).await.unwrap().as_ref(),
                b"FLAC"
            );
            let _ = finished.send(());
            upstream.await.unwrap();
        }
    }

    #[test]
    fn empty_tidal_track_configuration_adds_nothing() {
        assert!(parse_configured_tidal_track_ids("").is_empty());
        assert!(parse_configured_tidal_track_ids(" , ").is_empty());
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
    fn extracts_spotify_album_id_from_supported_links() {
        assert_eq!(
            spotify_album_id("https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy?si=test"),
            Some("4aawyAB9vmqN3uQ7FjRGTy".to_owned())
        );
        assert_eq!(
            spotify_album_id("https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy"),
            Some("4aawyAB9vmqN3uQ7FjRGTy".to_owned())
        );
        assert_eq!(
            spotify_album_id("spotify:album:4aawyAB9vmqN3uQ7FjRGTy"),
            Some("4aawyAB9vmqN3uQ7FjRGTy".to_owned())
        );
    }

    #[test]
    fn rejects_non_spotify_and_non_album_links() {
        assert_eq!(
            spotify_album_id("https://example.com/album/4aawyAB9vmqN3uQ7FjRGTy"),
            None
        );
        assert_eq!(
            spotify_album_id("https://open.spotify.com/track/4aawyAB9vmqN3uQ7FjRGTy"),
            None
        );
    }

    #[test]
    fn parses_audio_byte_ranges() {
        assert_eq!(requested_byte_range(None, 100).unwrap(), (0, 99, false));
        assert_eq!(
            requested_byte_range(Some(&HeaderValue::from_static("bytes=10-19")), 100).unwrap(),
            (10, 19, true)
        );
        assert_eq!(
            requested_byte_range(Some(&HeaderValue::from_static("bytes=-10")), 100).unwrap(),
            (90, 99, true)
        );
        assert!(requested_byte_range(Some(&HeaderValue::from_static("bytes=100-")), 100).is_err());
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
        let playlist = hls_playlist_body(44_100, 176_128, 1, 2, 8.0, None).unwrap();

        assert!(playlist.contains("#EXT-X-MAP:URI=\"dash/init\""));
        assert!(playlist.contains("#EXTINF:3.993832,\ndash/1"));
        assert!(playlist.contains("#EXTINF:3.993832,\ndash/2"));
        assert!(playlist.ends_with("#EXT-X-ENDLIST\n"));
    }

    #[test]
    fn ends_playlist_at_short_final_audio_fragment() {
        let playlist = hls_playlist_body(44_100, 176_128, 1, 59, 10_329_396.0 / 44_100.0, None).unwrap();
        let final_duration = (10_329_396.0 - 58.0 * 176_128.0) / 44_100.0;
        assert!(playlist.ends_with(&format!(
            "#EXTINF:{final_duration:.6},\ndash/59\n#EXT-X-ENDLIST\n"
        )));
        assert!(!playlist.contains("dash/60"));
    }

    #[test]
    fn native_hls_authenticates_initialization_and_every_segment() {
        let playlist = hls_playlist_body(44_100, 176_128, 1, 2, 8.0, Some("phone+token&value")).unwrap();
        assert!(playlist.contains("#EXT-X-MAP:URI=\"dash/init?access_token=phone%2Btoken%26value\""));
        assert!(playlist.contains("\ndash/1?access_token=phone%2Btoken%26value\n"));
        assert!(playlist.contains("\ndash/2?access_token=phone%2Btoken%26value\n"));
    }
}

#[cfg(test)]
mod search_coalescing_tests {
    use super::*;

    #[tokio::test]
    async fn identical_searches_share_a_lock_but_other_queries_do_not() {
        let requests = Mutex::new(HashMap::new());
        let key = SearchCacheKey {
            provider: MusicProvider::Qobuz,
            query: "deadman".into(),
            offset: 0,
            limit: 20,
        };
        let first = search_request_lock(&requests, &key).await;
        let second = search_request_lock(&requests, &key).await;
        assert!(Arc::ptr_eq(&first, &second));
        let other = search_request_lock(
            &requests,
            &SearchCacheKey {
                offset: 20,
                ..key.clone()
            },
        )
        .await;
        assert!(!Arc::ptr_eq(&first, &other));
        let guard = first.lock().await;
        assert!(second.try_lock().is_err());
        assert!(other.try_lock().is_ok());
        drop(guard);
        assert!(second.try_lock().is_ok());
        drop(first);
        drop(second);
        drop(other);
        let _next = search_request_lock(&requests, &key).await;
        assert_eq!(requests.lock().await.len(), 1);
    }
}

#[cfg(test)]
mod startup_gate_tests {
    use super::{path_needs_providers, providers_restored};
    use std::time::{Duration, Instant};
    use tokio::sync::watch;

    #[test]
    fn health_and_artwork_answer_while_providers_restore() {
        assert!(!path_needs_providers("/api/health"));
        assert!(!path_needs_providers("/api/recommendations/discover"));
        assert!(!path_needs_providers("/api/artwork/thumbnail"));
        assert!(!path_needs_providers("/api/artwork/palette"));
        assert!(!path_needs_providers("/api/music/local/tracks"));
        assert!(!path_needs_providers("/api/music/local/files/track.flac"));
        assert!(path_needs_providers("/api/library"));
        assert!(path_needs_providers("/api/search/providers"));
        assert!(path_needs_providers("/api/auth/status"));
        assert!(path_needs_providers("/api/providers/tidal/tracks/1/stream"));
    }

    #[tokio::test]
    async fn an_already_restored_server_never_waits() {
        let (_tx, rx) = watch::channel(true);
        let started = Instant::now();
        assert!(providers_restored(rx, Duration::from_secs(5)).await);
        assert!(started.elapsed() < Duration::from_millis(50));
    }

    #[tokio::test]
    async fn waiters_resume_as_soon_as_restoration_finishes() {
        let (tx, rx) = watch::channel(false);
        let waiters: Vec<_> = (0..8)
            .map(|_| tokio::spawn(providers_restored(rx.clone(), Duration::from_secs(5))))
            .collect();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let started = Instant::now();
        tx.send(true).unwrap();
        for waiter in waiters {
            assert!(waiter.await.unwrap());
        }
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[tokio::test]
    async fn a_stuck_restoration_times_out_instead_of_hanging() {
        let (_tx, rx) = watch::channel(false);
        assert!(!providers_restored(rx, Duration::from_millis(40)).await);
    }

    #[tokio::test]
    async fn a_dropped_sender_does_not_hang_requests() {
        let (tx, rx) = watch::channel(false);
        drop(tx);
        assert!(!providers_restored(rx, Duration::from_secs(5)).await);
    }
}
