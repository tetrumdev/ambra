use super::*;
use crate::providers::recommendations::{Mix, Recommendations};
use qbz_models::{lenient::parse_items_array, types::TrackToAnalyse};
use std::collections::HashSet;

const GENERATED_DAILY: &str = "daily-suggestions";

impl QobuzProvider {
    pub async fn recommendations(&self) -> ProviderResult<Recommendations> {
        self.recommendation_cache
            .recommendations(async {
                let (published, releases) = tokio::join!(
                    self.client.get_dynamic_mixes(),
                    self.client.get_release_watch("artists", 12, 0),
                );
                let mut mixes: Vec<_> = published?
                    .into_iter()
                    .filter(|mix| matches!(mix.kind.as_str(), "daily" | "weekly"))
                    .map(|mix| Mix {
                        id: mix.kind,
                        title: mix.title,
                        image_url: mix
                            .images
                            .get("small")
                            .filter(|url| url.starts_with("https://"))
                            .cloned(),
                    })
                    .collect();
                if !mixes.iter().any(|mix| mix.id == "daily") {
                    // Qobuz's desktop feed can expose only WeeklyQ. QBZ uses the
                    // provider's dynamic suggestions to generate a daily mix.
                    mixes.insert(
                        0,
                        Mix {
                            id: GENERATED_DAILY.into(),
                            title: "Daily suggestions".into(),
                            image_url: None,
                        },
                    );
                }
                // Release Watch is personalized to the artists followed on this account.
                let albums = match releases {
                    Ok(releases) => releases
                        .items
                        .into_iter()
                        .filter(|album| album.streamable != Some(false))
                        .map(catalog_album)
                        .collect(),
                    Err(error) => {
                        eprintln!("Could not load Qobuz Release Watch: {error}");
                        Vec::new()
                    }
                };
                Ok(Recommendations { mixes, albums })
            })
            .await
    }

    pub async fn recommendation_tracks(
        &self,
        id: &str,
        user_state: &Arc<crate::user_state::UserState>,
    ) -> ProviderResult<Vec<TrackMetadata>> {
        self.recommendation_cache
            .tracks(id, async {
                let tracks = if id == GENERATED_DAILY {
                    self.daily_suggestions(user_state).await?
                } else {
                    self.client.get_dynamic_mix_tracks(id, 100).await?
                };
                let mut seen = HashSet::new();
                Ok(tracks
                    .into_iter()
                    .filter(|track| track.is_streamable() && seen.insert(track.id))
                    .map(map_search_track)
                    .collect())
            })
            .await
    }

    async fn daily_suggestions(
        &self,
        user_state: &Arc<crate::user_state::UserState>,
    ) -> ProviderResult<Vec<Track>> {
        // Only Qobuz plays enter this request. Favorites are already scoped
        // to the connected Qobuz account and support users new to Ambra.
        let history = user_state
            .value("ambra.listening-history.v1")
            .await
            .map_err(io::Error::other)?;
        let mut seeds = recent_track_ids(history.as_deref());
        let favorites = self.client.get_favorites("tracks", 30, 0).await;
        let favorites: Vec<Track> = match favorites {
            Ok(value) => parse_items_array(&value, "tracks", "Qobuz favorite track"),
            Err(error) if seeds.is_empty() => return Err(error.into()),
            Err(_) => Vec::new(),
        };
        let mut seen: HashSet<_> = seeds.iter().copied().collect();
        seeds.extend(
            favorites
                .iter()
                .map(|track| track.id)
                .filter(|id| seen.insert(*id)),
        );
        if seeds.is_empty() {
            return Ok(Vec::new());
        }
        let sample: Vec<_> = (0..seeds.len().min(9))
            .map(|index| seeds[index * seeds.len() / seeds.len().min(9)])
            .collect();
        let missing: Vec<_> = sample
            .iter()
            .copied()
            .filter(|id| !favorites.iter().any(|track| track.id == *id))
            .collect();
        let mut details = favorites;
        if let Ok(tracks) = self.client.get_tracks_batch(&missing).await {
            details.extend(tracks);
        }
        let analyzed: Vec<_> = sample
            .into_iter()
            .filter_map(|id| {
                let track = details.iter().find(|track| track.id == id)?;
                let artist = track
                    .performer
                    .as_ref()
                    .or(track.composer.as_ref())
                    .filter(|artist| artist.id != 0)?;
                Some(TrackToAnalyse {
                    track_id: id,
                    artist_id: artist.id,
                    genre_id: track
                        .album
                        .as_ref()
                        .and_then(|album| album.genre.as_ref())
                        .map_or(0, |genre| genre.id),
                    label_id: track
                        .album
                        .as_ref()
                        .and_then(|album| album.label.as_ref())
                        .map_or(0, |label| label.id),
                })
            })
            .collect();
        let tracks = self
            .client
            .get_dynamic_suggest_full(&seeds, &analyzed, 50 - analyzed.len() as u32)
            .await?;
        if tracks.is_empty() && !analyzed.is_empty() {
            return Ok(self.client.get_dynamic_suggest(&seeds, 50).await?);
        }
        Ok(tracks)
    }
}

fn recent_track_ids(history: Option<&str>) -> Vec<u64> {
    #[derive(serde::Deserialize)]
    struct History {
        entries: Vec<Entry>,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry {
        track: HistoryTrack,
        last_played_at: u64,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HistoryTrack {
        global_id: String,
    }

    let Some(mut history) = history.and_then(|value| serde_json::from_str::<History>(value).ok())
    else {
        return Vec::new();
    };
    history
        .entries
        .sort_by_key(|entry| std::cmp::Reverse(entry.last_played_at));
    let mut seen = HashSet::new();
    history
        .entries
        .into_iter()
        .filter_map(|entry| {
            entry
                .track
                .global_id
                .strip_prefix("qobuz:")?
                .parse::<u64>()
                .ok()
        })
        .filter(|id| seen.insert(*id))
        .take(90)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn daily_suggestions_only_seed_distinct_qobuz_plays_in_recent_order() {
        let history = json!({"entries": [
            {"lastPlayedAt": 3, "track": {"globalId": "qobuz:23"}},
            {"lastPlayedAt": 2, "track": {"globalId": "qobuz:23"}},
            {"lastPlayedAt": 1, "track": {"globalId": "qobuz:1"}},
            {"lastPlayedAt": 6, "track": {"globalId": "tidal:5"}},
            {"lastPlayedAt": 5, "track": {"globalId": "qobuz:14"}},
            {"lastPlayedAt": 7, "track": {"globalId": "spotify:7"}}
        ]});
        assert_eq!(recent_track_ids(Some(&history.to_string())), [14, 23, 1]);
    }
}
