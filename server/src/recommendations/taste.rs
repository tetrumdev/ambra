use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use super::database::Database;

pub const DAY_MS: u64 = 86_400_000;
const RECENCY_DAYS: f64 = 45.0;
const OLD_PLAY_WEIGHT: f64 = 0.35;
const MAX_PROFILE_ARTISTS: usize = 128;
const MAX_PROFILE_GENRES: usize = 16;

#[derive(Default)]
pub struct Taste {
    pub genres: BTreeMap<i64, f64>,
    pub listened: BTreeMap<i64, f64>,
    pub saved_artists: BTreeSet<i64>,
}

fn artists(track: &Value) -> Vec<(&str, &str, Option<&str>)> {
    let mut artists = track["artists"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|artist| {
            Some((
                artist["name"].as_str()?,
                artist["providerId"].as_str().unwrap_or(""),
                artist["musicBrainzId"].as_str(),
            ))
        })
        .collect::<Vec<_>>();
    if artists.is_empty()
        && let Some(name) = track["artist"].as_str()
    {
        artists.push((name, "", track["musicBrainzArtistId"].as_str()));
    }
    artists
}

impl Taste {
    pub fn build(
        db: &Database,
        history: &Value,
        saved: &Value,
        now: u64,
    ) -> rusqlite::Result<Self> {
        let mut taste = Self::default();
        let mut preferences = BTreeMap::<i64, (f64, f64)>::new();
        let mut fallback_genres = BTreeMap::<i64, (f64, f64)>::new();
        for entry in history["entries"].as_array().into_iter().flatten() {
            let track = &entry["track"];
            let plays = entry["playCount"].as_u64().unwrap_or(1).clamp(1, 1_000_000) as f64;
            let days = now.saturating_sub(entry["lastPlayedAt"].as_u64().unwrap_or(0)) as f64
                / DAY_MS as f64;
            let recency = OLD_PLAY_WEIGHT + (1.0 - OLD_PLAY_WEIGHT) / (1.0 + days / RECENCY_DAYS);
            let credits = artists(track);
            let share = 1.0 / credits.len().max(1) as f64;
            let mut matched_artist = false;
            for (name, identity, mbid) in credits {
                if let Some(id) = db.identify(
                    name,
                    mbid,
                    track["provider"].as_str().unwrap_or(""),
                    identity,
                )? {
                    matched_artist = true;
                    let preference = preferences.entry(id).or_default();
                    preference.0 += plays * share;
                    preference.1 += plays * share * recency;
                }
            }
            // Existing provider/local album genres can fill gaps. These stay in user state,
            // never in the redistributable CC0 database and never sent to a catalog.
            if !matched_artist {
                let mut genres = BTreeSet::new();
                for genre in track["genres"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    if let Some(id) = db.genre(genre)? {
                        genres.insert(id);
                    }
                }
                let share = 1.0 / (genres.len().max(1) as f64).sqrt();
                for id in genres {
                    let preference = fallback_genres.entry(id).or_default();
                    preference.0 += plays * share;
                    preference.1 += plays * share * recency;
                }
            }
        }
        for track in saved["tracks"].as_array().into_iter().flatten() {
            for (name, identity, mbid) in artists(track) {
                if let Some(id) = db.identify(
                    name,
                    mbid,
                    track["provider"].as_str().unwrap_or(""),
                    identity,
                )? {
                    taste.saved_artists.insert(id);
                }
            }
        }
        let mut preferences = preferences
            .into_iter()
            .map(|(id, (plays, recent))| (id, plays.ln_1p() * recent / plays))
            .collect::<Vec<_>>();
        preferences.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        taste.listened = preferences.iter().copied().collect();
        for (id, weight) in preferences.into_iter().take(MAX_PROFILE_ARTISTS) {
            let genres = db.artist_genres(id)?;
            let per_genre = weight / (genres.len().max(1) as f64).sqrt();
            for genre in genres {
                *taste.genres.entry(genre).or_default() += per_genre;
            }
        }
        for (id, (plays, recent)) in fallback_genres {
            *taste.genres.entry(id).or_default() += plays.ln_1p() * recent / plays;
        }
        let mut genres = taste.genres.into_iter().collect::<Vec<_>>();
        genres.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        taste.genres = genres.into_iter().take(MAX_PROFILE_GENRES).collect();
        let total: f64 = taste.genres.values().sum();
        if total > 0.0 {
            for weight in taste.genres.values_mut() {
                *weight /= total;
            }
        }
        Ok(taste)
    }
}
