//! Catalog adapter and bounded background lifecycle. Ranking lives in recommendations.
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::atomic::{AtomicU64, AtomicUsize, Ordering},
    time::SystemTime,
};

use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use sha2::{Digest, Sha256};

use super::*;
use crate::recommendations::{
    database::{Artist, Database, normalize},
    ranking::{Candidate, rank, rotation},
    taste::{DAY_MS, Taste},
};

const ROW_LIMIT: usize = 12;
const LOOKUP_BUDGET: usize = 24;
const RESOLUTION_CONCURRENCY: usize = 2;
const SEARCH_LIMIT: u32 = 8;
const MATCH_CACHE_LIMIT: usize = 512;
const RATE_LIMIT_BACKOFF_SECONDS: u64 = 300;
const MATCH_TTL: Duration = Duration::from_secs(24 * 3600);
const NEGATIVE_TTL: Duration = Duration::from_secs(6 * 3600);
const RESULT_TTL: Duration = Duration::from_secs(3600);
const ERROR_TTL: Duration = Duration::from_secs(60);
const MAX_STALE: Duration = Duration::from_secs(7 * 24 * 3600);
const JOB_TIMEOUT: Duration = Duration::from_secs(100);

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiscoverResponse {
    tracks: Vec<Value>,
    reasons: BTreeMap<String, String>,
    generated_at: u64,
    status: &'static str,
    refresh_after_ms: Option<u64>,
}

impl DiscoverResponse {
    fn empty(status: &'static str) -> Self {
        Self {
            tracks: Vec::new(),
            reasons: BTreeMap::new(),
            generated_at: now(),
            status,
            refresh_after_ms: None,
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

struct CachedResult {
    key: String,
    when: Instant,
    response: DiscoverResponse,
}

#[derive(Clone)]
struct MatchedTracks {
    when: Instant,
    tracks: Vec<TrackMetadata>,
}

#[derive(Default)]
struct Backoff {
    failures: u32,
    until: Option<Instant>,
}

#[derive(Default)]
struct Cache {
    result: Option<CachedResult>,
    running: bool,
    matches: HashMap<(i64, MusicProvider), MatchedTracks>,
    backoff: HashMap<MusicProvider, Backoff>,
}

#[derive(Default)]
pub(super) struct Discover {
    cache: Mutex<Cache>,
    epoch: AtomicU64,
    // Database opens lazily on a blocking worker. Never put a synchronous SQLite lock
    // on the async playback executor. A failed open is retried after ERROR_TTL.
    database: Arc<std::sync::Mutex<Option<Database>>>,
}

impl Discover {
    pub(super) async fn invalidate(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let mut cache = self.cache.lock().await;
        cache.result = None;
        cache.matches.clear();
        cache.backoff.clear();
        // A running job still owns its slot; its epoch prevents committing old sessions.
    }
}

#[derive(Deserialize)]
pub(super) struct RequestQuery {
    limit: Option<usize>,
}

pub(super) async fn get(
    State(state): State<AppState>,
    Query(query): Query<RequestQuery>,
) -> Response {
    let limit = query.limit.unwrap_or(ROW_LIMIT).clamp(1, ROW_LIMIT);
    let response = match inputs(&state).await {
        Ok(input) => request(state, input).await,
        Err(error) => {
            eprintln!("Discover could not read synchronized state: {error}");
            DiscoverResponse::empty("stateUnavailable")
        }
    };
    let mut response = response;
    response.tracks.truncate(limit);
    let ids = response
        .tracks
        .iter()
        .filter_map(track_id)
        .collect::<BTreeSet<_>>();
    response.reasons.retain(|id, _| ids.contains(id.as_str()));
    ([(CACHE_CONTROL, "no-store")], Json(response)).into_response()
}

struct Inputs {
    history: Value,
    saved: Value,
    local: Vec<Value>,
    excluded: BTreeSet<String>,
    providers: Vec<MusicProvider>,
    day: u64,
    epoch: u64,
    key: String,
}

async fn inputs(state: &AppState) -> Result<Inputs, String> {
    let (history, saved) = state.user_state.recommendation_inputs().await?;
    let history = history.unwrap_or_else(|| "{}".into());
    let saved = saved.unwrap_or_else(|| "{}".into());
    let path = state
        .user_state
        .directory()
        .join("local-music/library.json");
    let local_bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => b"{}".to_vec(),
        Err(e) => return Err(e.to_string()),
    };
    let library = state
        .library_entries
        .read()
        .await
        .iter()
        .map(|entry| {
            format!(
                "{}:{}",
                provider_slug(entry.provider),
                entry.provider_track_id
            )
        })
        .collect::<BTreeSet<_>>();
    let providers = [
        MusicProvider::Tidal,
        MusicProvider::Qobuz,
        MusicProvider::Spotify,
    ]
    .into_iter()
    .filter(|provider| provider_is_configured(state, *provider))
    .collect::<Vec<_>>();
    let day = now() / DAY_MS;
    let epoch = state.discover.epoch.load(Ordering::SeqCst);
    tokio::task::spawn_blocking(move || {
        let local = serde_json::from_slice::<BTreeMap<String, Value>>(&local_bytes)
            .map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        for data in [
            history.as_bytes(),
            saved.as_bytes(),
            &serde_json::to_vec(&local).map_err(|e| e.to_string())?,
            &serde_json::to_vec(&library).map_err(|e| e.to_string())?,
            &serde_json::to_vec(&providers).map_err(|e| e.to_string())?,
            &day.to_le_bytes(),
            &epoch.to_le_bytes(),
        ] {
            hash.update((data.len() as u64).to_le_bytes());
            hash.update(data);
        }
        let history: Value = serde_json::from_str(&history).map_err(|e| e.to_string())?;
        let saved: Value = serde_json::from_str(&saved).map_err(|e| e.to_string())?;
        let mut excluded = library
            .into_iter()
            .map(|id| format!("id:{id}"))
            .collect::<BTreeSet<_>>();
        for track in history["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| &e["track"])
            .chain(saved["tracks"].as_array().into_iter().flatten())
        {
            excluded.extend(track_keys(track));
        }
        Ok(Inputs {
            history,
            saved,
            local: local.into_values().collect(),
            excluded,
            providers,
            day,
            epoch,
            key: format!("{:x}", hash.finalize()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn request(state: AppState, input: Inputs) -> DiscoverResponse {
    let mut cache = state.discover.cache.lock().await;
    if let Some(result) = &cache.result {
        let ttl = if matches!(
            result.response.status,
            "providerUnavailable" | "databaseUnavailable" | "stateUnavailable"
        ) {
            ERROR_TTL
        } else {
            RESULT_TTL
        };
        if result.key == input.key && result.when.elapsed() < ttl {
            return result.response.clone();
        }
    }
    // Old tracks may remain useful while tastes refresh, but never after being played,
    // saved or disconnected. Provider outages can also reuse the last successful matches.
    let mut response = cache
        .result
        .as_ref()
        .filter(|result| {
            now().saturating_sub(result.response.generated_at) < MAX_STALE.as_millis() as u64
        })
        .map(|result| result.response.clone())
        .unwrap_or_else(|| DiscoverResponse::empty("loading"));
    response
        .tracks
        .retain(|track| allowed_cached(track, &input));
    response.status = "loading";
    response.refresh_after_ms = Some(2000);
    if !cache.running {
        cache.running = true;
        let discover = state.discover.clone();
        let key = input.key.clone();
        let epoch = input.epoch;
        let state = state.clone();
        tokio::spawn(async move {
            let outcome = tokio::time::timeout(JOB_TIMEOUT, generate(&state, &input)).await;
            let result = match outcome {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => {
                    eprintln!("Discover metadata failed: {error}");
                    DiscoverResponse::empty("databaseUnavailable")
                }
                Err(_) => DiscoverResponse::empty("providerUnavailable"),
            };
            let mut cache = discover.cache.lock().await;
            if discover.epoch.load(Ordering::SeqCst) == epoch {
                let mut result = result;
                if result.status == "providerUnavailable"
                    && result.tracks.is_empty()
                    && let Some(previous) = &cache.result
                    && now().saturating_sub(previous.response.generated_at)
                        < MAX_STALE.as_millis() as u64
                {
                    result.generated_at = previous.response.generated_at;
                    result.tracks = previous
                        .response
                        .tracks
                        .iter()
                        .filter(|track| allowed_cached(track, &input))
                        .cloned()
                        .collect();
                    result.reasons = previous.response.reasons.clone();
                }
                cache.result = Some(CachedResult {
                    key,
                    when: Instant::now(),
                    response: result,
                });
            }
            cache.running = false;
        });
    }
    response
}

fn track_id(track: &Value) -> Option<&str> {
    track["globalId"].as_str().or_else(|| track["id"].as_str())
}

fn allowed_cached(track: &Value, input: &Inputs) -> bool {
    let provider = track["provider"].as_str().unwrap_or("");
    let connected = provider == "local"
        || input
            .providers
            .iter()
            .any(|p| provider_slug(*p) == provider);
    connected
        && !track_keys(track)
            .iter()
            .any(|key| input.excluded.contains(key))
}

async fn generate(state: &AppState, input: &Inputs) -> Result<DiscoverResponse, String> {
    if input.history["entries"]
        .as_array()
        .is_none_or(Vec::is_empty)
    {
        return Ok(DiscoverResponse::empty("insufficientHistory"));
    }
    let (history, saved, day, database) = (
        input.history.clone(),
        input.saved.clone(),
        input.day,
        state.discover.database.clone(),
    );
    let (taste, candidates) = tokio::task::spawn_blocking(move || {
        let mut guard = database.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = Some(Database::bundled()?);
        }
        let db = guard
            .as_ref()
            .ok_or("Recommendation database unavailable")?;
        let taste = Taste::build(db, &history, &saved, day * DAY_MS).map_err(|e| e.to_string())?;
        let candidates = rank(db, &taste, day).map_err(|e| e.to_string())?;
        Ok::<_, String>((taste, candidates))
    })
    .await
    .map_err(|e| e.to_string())??;
    if taste.genres.is_empty() {
        return Ok(DiscoverResponse::empty("insufficientHistory"));
    }
    if input.providers.is_empty() && input.local.is_empty() {
        return Ok(DiscoverResponse::empty("noProviders"));
    }
    let budget = &AtomicUsize::new(0);
    let failures = &AtomicUsize::new(0);
    // Buffered (not unordered) preserves deterministic rank order regardless of network timing.
    let resolved = stream::iter(candidates)
        .map(|candidate| async move {
            let mut tracks = input
                .local
                .iter()
                .filter(|track| {
                    candidate.artist.unambiguous_name
                        && candidate
                            .artist
                            .names
                            .contains(&normalize(track["artist"].as_str().unwrap_or("")))
                        && crate::user_state::track(track)
                        && allowed_cached(track, input)
                })
                .cloned()
                .collect::<Vec<_>>();
            if tracks.is_empty() {
                for &provider in &input.providers {
                    match resolve(state, &candidate, provider, budget, input.epoch).await {
                        Ok(found) => {
                            tracks = found
                                .into_iter()
                                .filter_map(|track| serde_json::to_value(track).ok())
                                .filter(|track| allowed_cached(track, input))
                                .collect();
                            if !tracks.is_empty() {
                                break;
                            }
                        }
                        Err(()) => {
                            failures.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            }
            // One track per artist. Stable daily recording choice, independent of search ordering.
            tracks.sort_by(|a, b| {
                let hash = |t: &Value| {
                    let digest = Sha256::digest(track_id(t).unwrap_or("").as_bytes());
                    rotation(
                        u64::from_le_bytes(digest[..8].try_into().unwrap()),
                        input.day,
                    )
                };
                hash(a)
                    .total_cmp(&hash(b))
                    .then(track_id(a).cmp(&track_id(b)))
            });
            (candidate, tracks)
        })
        .buffered(RESOLUTION_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let mut response = DiscoverResponse::empty("ready");
    let mut seen = BTreeSet::new();
    for (candidate, tracks) in resolved {
        for track in tracks {
            let identities = track_keys(&track);
            if identities.iter().any(|identity| seen.contains(identity)) {
                continue;
            }
            seen.extend(identities);
            if let Some(id) = track_id(&track) {
                response
                    .reasons
                    .insert(id.to_owned(), candidate.reason.clone());
            }
            response.tracks.push(track);
            break;
        }
        if response.tracks.len() == ROW_LIMIT {
            break;
        }
    }
    if response.tracks.is_empty() {
        response.status = if failures.load(Ordering::Relaxed) > 0 {
            "providerUnavailable"
        } else {
            "noMatches"
        };
    }
    Ok(response)
}

/// Keep all identities, so a recording with an ISRC also deduplicates a catalog
/// copy missing that ISRC. Names are used only for recording exclusion, never artist matching.
fn track_keys(track: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(id) = track_id(track) {
        keys.push(format!("id:{id}"));
    }
    if let Some(isrc) = track["isrc"].as_str().filter(|s| !s.is_empty()) {
        keys.push(format!("isrc:{}", isrc.to_uppercase()));
    }
    let title = normalize(
        track["title"]
            .as_str()
            .or_else(|| track["name"].as_str())
            .unwrap_or(""),
    );
    let artist = normalize(
        track["primaryArtist"]["name"]
            .as_str()
            .or_else(|| track["artist"].as_str())
            .unwrap_or(""),
    );
    if !title.is_empty() && !artist.is_empty() {
        keys.push(format!("song:{title}:{artist}"));
    }
    keys
}

/// Validate stable artist IDs when available. Otherwise require an unambiguous exact
/// canonical/alias name, with exactly one catalog identity across the entire search page.
fn matching_tracks(
    artist: &Artist,
    provider: MusicProvider,
    tracks: Vec<TrackMetadata>,
) -> Vec<TrackMetadata> {
    let known = artist.provider_ids.get(provider_slug(provider));
    let possible = tracks
        .into_iter()
        .filter(|track| {
            track.provider == provider
                && track.duration_seconds > 0
                && !track.playback.url.is_empty()
                && !track.primary_artist.provider_id.is_empty()
                && if let Some(ids) = known {
                    ids.contains(&track.primary_artist.provider_id)
                } else {
                    artist.unambiguous_name
                        && artist
                            .names
                            .contains(&normalize(&track.primary_artist.name))
                }
        })
        .collect::<Vec<_>>();
    if known.is_none()
        && possible
            .iter()
            .map(|t| &t.primary_artist.provider_id)
            .collect::<BTreeSet<_>>()
            .len()
            > 1
    {
        return Vec::new();
    }
    possible
}

async fn resolve(
    state: &AppState,
    candidate: &Candidate,
    provider: MusicProvider,
    budget: &AtomicUsize,
    epoch: u64,
) -> Result<Vec<TrackMetadata>, ()> {
    resolve_with(
        &state.discover,
        candidate,
        provider,
        budget,
        epoch,
        || async {
            search_tracks(
                State(state.clone()),
                Query(SearchTracksRequest {
                    provider,
                    query: candidate.artist.name.clone(),
                    limit: Some(SEARCH_LIMIT),
                    offset: 0,
                }),
            )
            .await
            .map(|Json(page)| page)
        },
    )
    .await
}

async fn resolve_with<F, Fut>(
    discover: &Discover,
    candidate: &Candidate,
    provider: MusicProvider,
    budget: &AtomicUsize,
    epoch: u64,
    search: F,
) -> Result<Vec<TrackMetadata>, ()>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<SearchPage, ApiError>>,
{
    let key = (candidate.artist.id, provider);
    let stale = {
        let cache = discover.cache.lock().await;
        let matched = cache.matches.get(&key).cloned();
        if let Some(matched) = &matched {
            let ttl = if matched.tracks.is_empty() {
                NEGATIVE_TTL
            } else {
                MATCH_TTL
            };
            if matched.when.elapsed() < ttl {
                return Ok(matched.tracks.clone());
            }
        }
        if cache
            .backoff
            .get(&provider)
            .and_then(|b| b.until)
            .is_some_and(|until| until > Instant::now())
        {
            return matched
                .filter(|m| m.when.elapsed() < MAX_STALE && !m.tracks.is_empty())
                .map(|m| m.tracks)
                .ok_or(());
        }
        matched
    };
    if budget.fetch_add(1, Ordering::Relaxed) >= LOOKUP_BUDGET {
        return Ok(Vec::new());
    }
    if candidate.artist.name.chars().count() > 160 {
        return Ok(Vec::new());
    }
    let result = tokio::time::timeout(Duration::from_secs(8), search())
        .await
        .unwrap_or_else(|_| Err(ApiError::service_unavailable("Catalog lookup timed out")));
    let mut cache = discover.cache.lock().await;
    if discover.epoch.load(Ordering::SeqCst) != epoch {
        return Err(());
    }
    match result {
        Ok(page) => {
            let tracks = matching_tracks(&candidate.artist, provider, page.tracks);
            cache.backoff.remove(&provider);
            if cache.matches.len() >= MATCH_CACHE_LIMIT
                && let Some(oldest) = cache
                    .matches
                    .iter()
                    .min_by_key(|(_, m)| m.when)
                    .map(|(key, _)| *key)
            {
                cache.matches.remove(&oldest);
            }
            cache.matches.insert(
                key,
                MatchedTracks {
                    when: Instant::now(),
                    tracks: tracks.clone(),
                },
            );
            Ok(tracks)
        }
        Err(error) => {
            let rate_limited = error.message.contains("429")
                || error.message.to_lowercase().contains("rate limit");
            let backoff = cache.backoff.entry(provider).or_default();
            backoff.failures = backoff.failures.saturating_add(1);
            let seconds = 30u64
                .saturating_mul(1u64 << backoff.failures.min(6))
                .min(1800)
                .max(if rate_limited {
                    RATE_LIMIT_BACKOFF_SECONDS
                } else {
                    0
                });
            backoff.until = Some(Instant::now() + Duration::from_secs(seconds));
            stale
                .filter(|m| m.when.elapsed() < MAX_STALE && !m.tracks.is_empty())
                .map(|m| m.tracks)
                .ok_or(())
        }
    }
}

#[cfg(test)]
mod tests;
