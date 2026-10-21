use super::*;
use crate::artwork_quality::same_release_upc;
use crate::credits::{AlbumInfo, TrackCredits};

/// Credits and descriptions come from the richest catalog that has the recording or release.
/// Spotify's are too thin to be worth showing.
const SOURCES: [MusicProvider; 2] = [MusicProvider::Qobuz, MusicProvider::Tidal];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TrackReference {
    provider: MusicProvider,
    track_id: String,
    isrc: Option<String>,
    title: String,
    artist: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AlbumReference {
    provider: MusicProvider,
    album_id: String,
    title: String,
    upc: Option<String>,
    /// One of its recordings, to find the release on catalogs that cannot look up a UPC.
    track: Option<TrackReference>,
}

pub(super) async fn track(
    State(state): State<AppState>,
    Json(reference): Json<TrackReference>,
) -> Result<Json<TrackCredits>, ApiError> {
    let mut failed = false;
    for source in SOURCES {
        let Some(id) = counterpart_track(&state, source, &reference).await else {
            continue;
        };
        let credits = match source {
            MusicProvider::Qobuz => qobuz_provider(&state)?.track_credits(&id).await,
            MusicProvider::Tidal => tidal_provider(&state)?.track_credits(&id).await,
            MusicProvider::Spotify => continue,
        };
        match credits {
            Ok(credits) if !credits.is_empty() => {
                return Ok(Json(TrackCredits {
                    source: Some(source),
                    credits,
                }));
            }
            Ok(_) => {}
            Err(_) => failed = true,
        }
    }
    if failed {
        return Err(ApiError::upstream("Credits couldn't be loaded."));
    }
    Ok(Json(TrackCredits {
        source: None,
        credits: Vec::new(),
    }))
}

pub(super) async fn album(
    State(state): State<AppState>,
    Json(reference): Json<AlbumReference>,
) -> Result<Json<AlbumInfo>, ApiError> {
    let mut failed = false;
    for source in SOURCES {
        let Some(id) = counterpart_album(&state, source, &reference).await else {
            continue;
        };
        let info = match source {
            MusicProvider::Qobuz => qobuz_provider(&state)?.album_info(&id).await,
            MusicProvider::Tidal => tidal_provider(&state)?.album_info(&id).await,
            MusicProvider::Spotify => continue,
        };
        match info {
            Ok(info) if !info.credits.is_empty() || info.description.is_some() => {
                return Ok(Json(info));
            }
            Ok(_) => {}
            Err(_) => failed = true,
        }
    }
    if failed {
        return Err(ApiError::upstream("Album info couldn't be loaded."));
    }
    Ok(Json(AlbumInfo::default()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Biography {
    biography: Option<String>,
    biography_source: Option<String>,
}

pub(super) async fn artist_biography(
    State(state): State<AppState>,
    Path((provider, artist_id)): Path<(MusicProvider, String)>,
) -> Result<Json<Biography>, ApiError> {
    if provider == MusicProvider::Spotify {
        return Ok(Json(Biography {
            biography: None,
            biography_source: None,
        }));
    }
    let profile = cached_artist_metadata(&state, provider, &artist_id).await?;
    Ok(Json(Biography {
        biography: profile.biography,
        biography_source: profile.biography_source,
    }))
}

fn connected(state: &AppState, provider: MusicProvider) -> bool {
    match provider {
        MusicProvider::Qobuz => state.qobuz.get().is_some(),
        MusicProvider::Tidal => state.tidal.get().is_some(),
        MusicProvider::Spotify => false,
    }
}

async fn counterpart_track(
    state: &AppState,
    target: MusicProvider,
    reference: &TrackReference,
) -> Option<String> {
    if !connected(state, target) {
        return None;
    }
    if reference.provider == target {
        return Some(reference.track_id.clone());
    }
    let isrc = reference.isrc.as_deref()?;
    recording_by_isrc(state, target, isrc, &reference.title, &reference.artist)
        .await
        .map(|track| track.provider_track_id)
}

async fn counterpart_album(
    state: &AppState,
    target: MusicProvider,
    reference: &AlbumReference,
) -> Option<String> {
    if !connected(state, target) {
        return None;
    }
    if reference.provider == target {
        return Some(reference.album_id.clone());
    }
    if target == MusicProvider::Qobuz
        && let Some(upc) = reference.upc.as_deref()
        && let Some(id) = qobuz_provider(state)
            .ok()?
            .album_id_by_upc(upc)
            .await
            .ok()
            .flatten()
    {
        return Some(id);
    }
    // Through one of its recordings, as long as that copy is on the same release
    // rather than a compilation or reissue.
    let track = reference.track.as_ref()?;
    let found = recording_by_isrc(
        state,
        target,
        track.isrc.as_deref()?,
        &track.title,
        &track.artist,
    )
    .await?;
    let album = found.album?;
    let same_release = match (reference.upc.as_deref(), album.upc.as_deref()) {
        (Some(source), Some(candidate)) => same_release_upc(source, candidate),
        _ => normalized_title(&reference.title) == normalized_title(&album.title),
    };
    same_release.then_some(album.provider_id)
}

/// Matched only by ISRC: a similar title is never enough to borrow another recording's credits.
async fn recording_by_isrc(
    state: &AppState,
    target: MusicProvider,
    isrc: &str,
    title: &str,
    artist: &str,
) -> Option<TrackMetadata> {
    let isrc = isrc.trim();
    if isrc.is_empty() || isrc.len() > 32 {
        return None;
    }
    let by_name: String = format!("{title} {artist}").chars().take(200).collect();
    for query in [isrc.to_owned(), by_name] {
        let Ok(Json(page)) = search_tracks(
            State(state.clone()),
            Query(SearchTracksRequest {
                provider: target,
                query,
                offset: 0,
                limit: Some(10),
            }),
        )
        .await
        else {
            continue;
        };
        if let Some(track) = page.tracks.into_iter().find(|track| {
            track
                .isrc
                .as_deref()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(isrc))
        }) {
            return Some(track);
        }
    }
    None
}

fn normalized_title(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
