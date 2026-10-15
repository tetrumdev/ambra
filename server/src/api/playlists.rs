use super::*;
use crate::playlists::{
    MatchTrack, PlaylistChange, PlaylistContents, PlaylistEntry, ServicePlaylist,
};

macro_rules! provider_call {
    ($state:expr, $provider:expr, $method:ident $(, $argument:expr)*) => {
        match $provider {
            MusicProvider::Tidal => tidal_provider($state)?.$method($($argument),*).await,
            MusicProvider::Qobuz => qobuz_provider($state)?.$method($($argument),*).await,
            MusicProvider::Spotify => spotify_provider($state).await?.$method($($argument),*).await,
        }.map_err(ApiError::upstream)
    };
}

pub(super) async fn list(
    State(state): State<AppState>,
    Path(provider): Path<MusicProvider>,
) -> Result<Json<Vec<ServicePlaylist>>, ApiError> {
    Ok(Json(provider_call!(&state, provider, playlists)?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ContentsResponse {
    #[serde(flatten)]
    contents: PlaylistContents,
    tracks: Vec<TrackMetadata>,
    unavailable_count: usize,
}

pub(super) async fn contents(
    State(state): State<AppState>,
    Path((provider, id)): Path<(MusicProvider, String)>,
) -> Result<Json<ContentsResponse>, ApiError> {
    validate_id(&id)?;
    let contents = provider_call!(&state, provider, playlist, &id)?;
    let mut seen = HashSet::new();
    let entries: Vec<LibraryEntry> = contents
        .entries
        .iter()
        .filter(|entry| seen.insert(entry.track_id.clone()))
        .map(|entry| LibraryEntry {
            provider,
            provider_track_id: entry.track_id.clone(),
        })
        .collect();
    let tracks = load_search_tracks(&state, &entries).await;
    let unavailable_count = entries.len().saturating_sub(tracks.len());
    Ok(Json(ContentsResponse {
        contents,
        tracks,
        unavailable_count,
    }))
}

pub(super) async fn change(
    State(state): State<AppState>,
    Path((provider, id)): Path<(MusicProvider, String)>,
    Json(change): Json<PlaylistChange>,
) -> Result<Json<serde_json::Value>, ApiError> {
    validate_id(&id)?;
    let key = format!("{}:{id}", provider_slug(provider));
    let lock = {
        let mut locks = state.playlist_mutations.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(Mutex::new(()));
            locks.insert(key, Arc::downgrade(&lock));
            lock
        }
    };
    let _guard = lock.lock().await;
    let current = provider_call!(&state, provider, playlist, &id)?;
    if !current.playlist.editable {
        return Err(ApiError::bad_request("This service playlist is read-only."));
    }
    match change {
        PlaylistChange::Add { track } => {
            let target = matching_track(&state, provider, &track).await?;
            if !current.entries.iter().any(|entry| entry.track_id == target) {
                provider_call!(
                    &state,
                    provider,
                    add_playlist_track,
                    &id,
                    &target,
                    &current.revision
                )?;
            }
        }
        PlaylistChange::Remove {
            track_ids,
            revision,
        } => {
            if revision != current.revision {
                return Err(ApiError {
                    status: StatusCode::CONFLICT,
                    message: "Playlist changed on another device. Refresh and try again.".into(),
                    content_range: None,
                });
            }
            if track_ids.is_empty() || track_ids.len() > 100 {
                return Err(ApiError::bad_request("Select between 1 and 100 tracks."));
            }
            let entries: Vec<PlaylistEntry> = current
                .entries
                .iter()
                .filter(|entry| track_ids.contains(&entry.track_id))
                .cloned()
                .collect();
            if !entries.is_empty() {
                provider_call!(
                    &state,
                    provider,
                    remove_playlist_tracks,
                    &id,
                    &entries,
                    &current.revision
                )?;
            }
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn validate_id(id: &str) -> Result<(), ApiError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return Err(ApiError::bad_request("Invalid playlist or track ID"));
    }
    Ok(())
}

fn normalized(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

async fn matching_track(
    state: &AppState,
    provider: MusicProvider,
    source: &MatchTrack,
) -> Result<String, ApiError> {
    if source.name.trim().is_empty()
        || source.artist.trim().is_empty()
        || source.name.len() > 1000
        || source.artist.len() > 1000
        || !source.duration_seconds.is_finite()
        || !(0.0..=86_400.0).contains(&source.duration_seconds)
        || source.isrc.as_ref().is_some_and(|isrc| isrc.len() > 32)
    {
        return Err(ApiError::bad_request("Invalid track metadata"));
    }
    if source.provider == provider_slug(provider) {
        validate_id(&source.provider_track_id)?;
        return Ok(source.provider_track_id.clone());
    }
    let mut queries = Vec::new();
    if let Some(isrc) = &source.isrc {
        queries.push(format!("isrc:{isrc}"));
    }
    queries.push(
        format!("{} {}", source.name, source.artist)
            .chars()
            .take(200)
            .collect(),
    );
    for query in queries {
        let Json(page) = search_tracks(
            State(state.clone()),
            Query(SearchTracksRequest {
                provider,
                query,
                offset: 0,
                limit: Some(10),
            }),
        )
        .await?;
        for track in page.tracks {
            let same_recording = match (&source.isrc, &track.isrc) {
                (Some(source), Some(target)) => source.eq_ignore_ascii_case(target),
                _ => false,
            };
            let title = match &track.version {
                Some(version) => format!("{} ({version})", track.title),
                None => track.title.clone(),
            };
            let same_metadata = normalized(&source.name) == normalized(&title)
                && track
                    .artists
                    .iter()
                    .chain(std::iter::once(&track.primary_artist))
                    .any(|artist| normalized(&source.artist) == normalized(&artist.name))
                && source.duration_seconds > 0.0
                && (source.duration_seconds - track.duration_seconds as f64).abs() <= 3.0;
            if same_recording || (same_metadata && (source.isrc.is_none() || track.isrc.is_none()))
            {
                return Ok(track.provider_track_id);
            }
        }
    }
    Err(ApiError::bad_request(format!(
        "No matching recording found on {}. Nothing was added.",
        provider_name(provider)
    )))
}
