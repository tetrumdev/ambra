use crate::media_cache::MediaCache;
use std::{
    collections::{HashMap, HashSet},
    env, fs, io,
    path::PathBuf,
    sync::{Arc, Weak},
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
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
use bytes::Bytes;
use futures_util::{StreamExt, TryStreamExt, stream};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::{Any, CorsLayer};

use crate::{
    artwork_quality::{
        ArtworkCandidate, dominant_colors, highest_resolution, image_dimensions, normalized_upc,
        qobuz_max_artwork_url, trusted_artwork_url,
    },
    login_setup,
    models::{HealthResponse, LibraryResponse, MusicProvider, SearchPage, TrackMetadata},
    providers::qobuz::QobuzProvider,
    providers::spotify::SpotifyProvider,
    providers::tidal::{PlaybackSource, TidalProvider},
};

const DEFAULT_ADDRESS: &str = "127.0.0.1:8787";
const DEFAULT_SEARCH_PAGE_SIZE: u32 = 10;
const MAX_SEARCH_PAGE_SIZE: u32 = 50;
const SEARCH_CACHE_LIMIT: usize = 100;
const SEARCH_METADATA_TIMEOUT: Duration = Duration::from_secs(6);
const UPSTREAM_ATTEMPTS: usize = 3;

type ServerResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone)]
struct AppState {
    tidal: Option<TidalProvider>,
    qobuz: Option<QobuzProvider>,
    spotify: Option<SpotifyProvider>,
    http_client: reqwest::Client,
    library_entries: Arc<RwLock<Vec<LibraryEntry>>>,
    search_cache: Arc<RwLock<HashMap<SearchCacheKey, CachedSearchPage>>>,
    catalog_cache:
        Arc<RwLock<HashMap<SearchCacheKey, (Instant, crate::models::CatalogSearchPage)>>>,
    search_fetches: Arc<Mutex<HashMap<SearchCacheKey, Weak<Mutex<()>>>>>,
    media_cache: Arc<RwLock<MediaCache>>,
    media_fetches: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
    artwork_quality_cache: Arc<RwLock<HashMap<String, ArtworkCandidate>>>,
    artwork_dimensions_cache: Arc<RwLock<HashMap<String, (u32, u32)>>>,
    artwork_palette_cache: Arc<RwLock<HashMap<String, Vec<String>>>>,
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

pub async fn serve() -> ServerResult<()> {
    let offer_logins = login_setup::setup_needed();
    let tidal = authenticate_tidal(offer_logins).await?;
    let qobuz = authenticate_qobuz(offer_logins).await?;
    let spotify = authenticate_spotify(offer_logins).await?;
    if offer_logins {
        login_setup::finish_setup()?;
        println!(
            "Login choices saved. To choose skipped services later, run `cargo run -- reset-logins`, then `cargo run`."
        );
    }

    let http_client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(16)
        .tcp_keepalive(Duration::from_secs(30))
        .build()?;
    let media_cache = tidal
        .as_ref()
        .map(|provider| provider.media_cache.clone())
        .unwrap_or_else(|| Arc::new(RwLock::new(MediaCache::default())));
    let state = AppState {
        tidal,
        qobuz,
        spotify,
        http_client,
        library_entries: Arc::new(RwLock::new(initial_library_entries())),
        search_cache: Arc::new(RwLock::new(HashMap::new())),
        catalog_cache: Arc::new(RwLock::new(HashMap::new())),
        search_fetches: Arc::new(Mutex::new(HashMap::new())),
        media_cache,
        media_fetches: Arc::new(Mutex::new(HashMap::new())),
        artwork_quality_cache: Arc::new(RwLock::new(HashMap::new())),
        artwork_dimensions_cache: Arc::new(RwLock::new(HashMap::new())),
        artwork_palette_cache: Arc::new(RwLock::new(HashMap::new())),
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
        .route("/api/library/tracks", post(add_track))
        .route("/api/search/tracks", get(search_tracks))
        .route("/api/search/providers", get(search_providers))
        .route("/api/search/catalog", get(search_catalog))
        .route(
            "/api/providers/{provider}/tracks/{track_id}/metadata",
            get(track_metadata),
        )
        .route(
            "/api/providers/{provider}/tracks/{track_id}/playback",
            get(track_playback),
        )
        .route("/api/quality/artwork", post(resolve_artwork_quality))
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
        .layer(cors)
        .with_state(state);

    let address = env::var("AMBRA_SERVER_ADDRESS").unwrap_or_else(|_| DEFAULT_ADDRESS.to_owned());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("Ambra server listening on http://{address}");

    axum::serve(listener, app).await?;
    Ok(())
}

async fn authenticate_tidal(offer_login: bool) -> ServerResult<Option<TidalProvider>> {
    match TidalProvider::authenticate_if_configured(false).await {
        Ok(Some(provider)) => return Ok(Some(provider)),
        Ok(None) => {}
        Err(error) => eprintln!("Tidal saved login failed: {error}"),
    }
    if offer_login && login_setup::ask_to_log_in("Tidal")? {
        match TidalProvider::authenticate_if_configured(true).await {
            Ok(provider) => return Ok(provider),
            Err(error) => eprintln!("Tidal disabled because login failed: {error}"),
        }
    }
    Ok(None)
}

async fn authenticate_qobuz(offer_login: bool) -> ServerResult<Option<QobuzProvider>> {
    match QobuzProvider::authenticate_if_configured(false).await {
        Ok(Some(provider)) => return Ok(Some(provider)),
        Ok(None) => {}
        Err(error) => eprintln!("Qobuz saved login failed: {error}"),
    }
    if offer_login && login_setup::ask_to_log_in("Qobuz")? {
        match QobuzProvider::authenticate_if_configured(true).await {
            Ok(provider) => return Ok(provider),
            Err(error) => eprintln!("Qobuz disabled because login failed: {error}"),
        }
    }
    Ok(None)
}

async fn authenticate_spotify(offer_login: bool) -> ServerResult<Option<SpotifyProvider>> {
    match SpotifyProvider::authenticate_if_configured(false).await {
        Ok(Some(provider)) => return Ok(Some(provider)),
        Ok(None) => {}
        Err(error) => eprintln!("Spotify saved login failed: {error}"),
    }
    if offer_login && login_setup::ask_to_log_in("Spotify")? {
        match SpotifyProvider::authenticate_if_configured(true).await {
            Ok(provider) => return Ok(provider),
            Err(error) => eprintln!("Spotify disabled because login failed: {error}"),
        }
    }
    Ok(None)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
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

    let cache_key = format!(
        "{provider}:{}:{}",
        request.album_id,
        upc.as_deref().and_then(normalized_upc).unwrap_or_default()
    );
    if let Some(cached) = state
        .artwork_quality_cache
        .read()
        .await
        .get(&cache_key)
        .cloned()
    {
        return Ok(Json(cached));
    }

    let qobuz_url = if request.source_provider == MusicProvider::Qobuz {
        qobuz_max_artwork_url(&request.cover_url)
    } else if let (Some(qobuz), Some(upc)) = (state.qobuz.as_ref(), upc.as_deref()) {
        qobuz
            .exact_album_artwork_by_upc(upc)
            .await
            .map_err(ApiError::upstream)?
    } else {
        None
    };

    let palette_url = request.cover_url.clone();
    let source_dimensions = cached_artwork_dimensions(&state, &request.cover_url)
        .await
        .ok_or_else(|| ApiError::upstream("Could not inspect source artwork dimensions"))?;
    let source = ArtworkCandidate {
        provider: provider.to_owned(),
        url: request.cover_url,
        width: source_dimensions.0,
        height: source_dimensions.1,
        colors: Vec::new(),
    };
    let qobuz = if let Some(url) = qobuz_url.filter(|url| url != &source.url) {
        let (width, height) = cached_artwork_dimensions(&state, &url)
            .await
            .ok_or_else(|| ApiError::upstream("Could not inspect Qobuz artwork dimensions"))?;
        Some(ArtworkCandidate {
            provider: "qobuz".to_owned(),
            url,
            width,
            height,
            colors: Vec::new(),
        })
    } else {
        None
    };
    let mut best = highest_resolution(source, qobuz);
    best.colors = cached_artwork_palette(&state, &palette_url)
        .await
        .unwrap_or_default();

    if best.colors.len() == 4 {
        state
            .artwork_quality_cache
            .write()
            .await
            .insert(cache_key, best.clone());
    }
    Ok(Json(best))
}

async fn cached_artwork_palette(state: &AppState, url: &str) -> Option<Vec<String>> {
    if let Some(cached) = state.artwork_palette_cache.read().await.get(url).cloned() {
        return Some(cached);
    }

    const MAX_ARTWORK_BYTES: u64 = 16 * 1024 * 1024;
    let response = state.http_client.get(url).send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_ARTWORK_BYTES)
    {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    if bytes.len() as u64 > MAX_ARTWORK_BYTES {
        return None;
    }

    let colors = dominant_colors(&bytes)?;
    state
        .artwork_palette_cache
        .write()
        .await
        .insert(url.to_owned(), colors.clone());
    Some(colors)
}

async fn cached_artwork_dimensions(state: &AppState, url: &str) -> Option<(u32, u32)> {
    if let Some(cached) = state
        .artwork_dimensions_cache
        .read()
        .await
        .get(url)
        .copied()
    {
        return Some(cached);
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
        state
            .artwork_dimensions_cache
            .write()
            .await
            .insert(url.to_owned(), dimensions);
        return Some(dimensions);
    }
    None
}

async fn library(State(state): State<AppState>) -> Result<Json<LibraryResponse>, ApiError> {
    let entries = state.library_entries.read().await.clone();
    let available_entries = entries
        .into_iter()
        .filter(|entry| provider_is_configured(&state, entry.provider))
        .collect::<Vec<_>>();
    let tracks = load_tracks(&state, &available_entries).await?;

    Ok(Json(LibraryResponse { tracks }))
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
                let ids = spotify_provider(&state)?
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
                        image_url: album.cover_url.clone(),
                        upc: album.upc.clone(),
                        release_date: album.release_date.clone(),
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
                let mut ids = spotify_provider(&state)?
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackPlaybackResponse {
    quality: String,
    maximum_sampling_rate_khz: Option<f64>,
    maximum_bit_depth: Option<u32>,
    playback: crate::models::PlaybackMetadata,
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
) -> Result<Json<TrackPlaybackResponse>, ApiError> {
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
    let (playback, quality, maximum_sampling_rate_khz, maximum_bit_depth) = tidal_provider(&state)?
        .playback_metadata(&track_id)
        .await
        .map_err(ApiError::upstream)?;

    Ok(Json(TrackPlaybackResponse {
        quality,
        maximum_sampling_rate_khz,
        maximum_bit_depth,
        playback,
    }))
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

    Ok(Json(LibraryResponse { tracks }))
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

async fn import_album(
    state: &AppState,
    provider: MusicProvider,
    album_id: String,
) -> Result<Json<LibraryResponse>, ApiError> {
    let track_ids = match provider {
        MusicProvider::Tidal => tidal_provider(state)?
            .album_track_ids(&album_id)
            .await
            .map_err(ApiError::upstream)?,
        MusicProvider::Qobuz => qobuz_provider(state)?
            .album_track_ids(&album_id)
            .await
            .map_err(ApiError::upstream)?,
        MusicProvider::Spotify => spotify_provider(state)?
            .album_track_ids(&album_id)
            .await
            .map_err(ApiError::upstream)?,
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
                .as_ref()
                .ok_or_else(|| io::Error::other("Tidal login is not configured"))?
                .track_metadata(&entry.provider_track_id)
                .await
        }
        MusicProvider::Qobuz => {
            state
                .qobuz
                .as_ref()
                .ok_or_else(|| io::Error::other("Qobuz login is not configured"))?
                .track_metadata(&entry.provider_track_id)
                .await
        }
        MusicProvider::Spotify => {
            state
                .spotify
                .as_ref()
                .ok_or_else(|| io::Error::other("Spotify login is not configured"))?
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
    let prepared = spotify_provider(state)?
        .prepare_stream(track_id)
        .await
        .map_err(ApiError::upstream)?;
    let total_length = prepared.content_length();
    let (start, end_inclusive, partial) = requested_byte_range(headers.get(RANGE), total_length)?;
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
    track_duration_seconds: f64,
) -> Result<String, ApiError> {
    if timescale == 0 || segment_duration == 0 || segment_count == 0 {
        return Err(ApiError::internal("Invalid segmented audio timing"));
    }

    let nominal_duration = f64::from(segment_duration) / f64::from(timescale);
    let target_duration = nominal_duration.ceil().max(1.0) as u64;
    let mut remaining = track_duration_seconds;
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

fn tidal_provider(state: &AppState) -> Result<&TidalProvider, ApiError> {
    state.tidal.as_ref().ok_or_else(|| {
        ApiError::service_unavailable(
            "Tidal login is not configured. Run `cargo run -- reset-logins`, then restart with `cargo run`.",
        )
    })
}

fn qobuz_provider(state: &AppState) -> Result<&QobuzProvider, ApiError> {
    state.qobuz.as_ref().ok_or_else(|| {
        ApiError::service_unavailable(
            "Qobuz login is not configured. Run `cargo run -- reset-logins`, then restart with `cargo run`.",
        )
    })
}

fn spotify_provider(state: &AppState) -> Result<&SpotifyProvider, ApiError> {
    state.spotify.as_ref().ok_or_else(|| {
        ApiError::service_unavailable(
            "Spotify login is not configured. Run `cargo run -- reset-logins`, then restart with `cargo run`.",
        )
    })
}

fn provider_is_configured(state: &AppState, provider: MusicProvider) -> bool {
    match provider {
        MusicProvider::Tidal => state.tidal.is_some(),
        MusicProvider::Qobuz => state.qobuz.is_some(),
        MusicProvider::Spotify => state.spotify.is_some(),
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
    if let Some(bytes) = state.media_cache.read().await.get(url) {
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
    if let Some(bytes) = state.media_cache.read().await.get(url) {
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
    if let Some(cached) = state.media_cache.read().await.get(url) {
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
    use super::{
        LibraryEntry, hls_playlist_body, move_entries_to_end, parse_configured_tidal_track_ids,
        qobuz_album_id, requested_byte_range, spotify_album_id, tidal_album_id,
    };
    use crate::models::MusicProvider;
    use axum::http::HeaderValue;

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
        let playlist = hls_playlist_body(44_100, 176_128, 1, 2, 8.0).unwrap();

        assert!(playlist.contains("#EXT-X-MAP:URI=\"dash/init\""));
        assert!(playlist.contains("#EXTINF:3.993832,\ndash/1"));
        assert!(playlist.contains("#EXTINF:3.993832,\ndash/2"));
        assert!(playlist.ends_with("#EXT-X-ENDLIST\n"));
    }

    #[test]
    fn ends_playlist_at_short_final_audio_fragment() {
        let playlist = hls_playlist_body(44_100, 176_128, 1, 59, 10_329_396.0 / 44_100.0).unwrap();
        let final_duration = (10_329_396.0 - 58.0 * 176_128.0) / 44_100.0;
        assert!(playlist.ends_with(&format!(
            "#EXTINF:{final_duration:.6},\ndash/59\n#EXT-X-ENDLIST\n"
        )));
        assert!(!playlist.contains("dash/60"));
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
