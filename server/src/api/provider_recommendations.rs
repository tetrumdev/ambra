use super::*;
use crate::providers::recommendations::Recommendations;

pub(super) async fn list(
    State(state): State<AppState>,
    Path(provider): Path<MusicProvider>,
) -> Result<Json<Recommendations>, ApiError> {
    let result = match provider {
        MusicProvider::Spotify => spotify_provider(&state).await?.recommendations().await,
        MusicProvider::Tidal => tidal_provider(&state)?.recommendations().await,
        MusicProvider::Qobuz => qobuz_provider(&state)?.recommendations().await,
    };
    result.map(Json).map_err(|error| upstream(provider, error))
}

pub(super) async fn tracks(
    State(state): State<AppState>,
    Path((provider, id)): Path<(MusicProvider, String)>,
) -> Result<Json<Vec<TrackMetadata>>, ApiError> {
    let result = match provider {
        MusicProvider::Spotify => {
            let spotify = spotify_provider(&state).await?;
            require_mix(spotify.recommendations().await, provider, &id)?;
            spotify.recommendation_tracks(&id).await
        }
        MusicProvider::Tidal => {
            let tidal = tidal_provider(&state)?;
            require_mix(tidal.recommendations().await, provider, &id)?;
            tidal.recommendation_tracks(&id).await
        }
        MusicProvider::Qobuz => {
            let qobuz = qobuz_provider(&state)?;
            require_mix(qobuz.recommendations().await, provider, &id)?;
            qobuz.recommendation_tracks(&id, &state.user_state).await
        }
    };
    result.map(Json).map_err(|error| upstream(provider, error))
}

fn require_mix(
    result: ServerResult<Recommendations>,
    provider: MusicProvider,
    id: &str,
) -> Result<(), ApiError> {
    let recommendations = result.map_err(|error| upstream(provider, error))?;
    if recommendations.mixes.iter().any(|mix| mix.id == id) {
        return Ok(());
    }
    Err(ApiError::not_found(
        "This recommendation is no longer available.".into(),
    ))
}

fn upstream(provider: MusicProvider, error: impl std::fmt::Display) -> ApiError {
    let name = provider_name(provider);
    eprintln!("Could not load {name} recommendations: {error}");
    ApiError::upstream(format!("Could not load {name} recommendations. Try again."))
}
