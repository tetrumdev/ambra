mod formats;
mod model;
mod providers;
mod ttml;

pub use model::LyricsResponse;
use providers::{Provider, ProviderClient};
use serde::Deserialize;
use std::io;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsRequest {
    track_name: String,
    artist_name: String,
    #[serde(default)]
    album_name: String,
    duration_seconds: Option<f64>,
    isrc: Option<String>,
    spotify_id: Option<String>,
    apple_music_id: Option<String>,
    #[serde(default)]
    version: String,
}

impl LyricsRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.track_name.trim().is_empty() || self.artist_name.trim().is_empty() {
            return Err("Track title and artist are required");
        }
        if [
            &self.track_name,
            &self.artist_name,
            &self.album_name,
            &self.version,
        ]
        .iter()
        .any(|value| value.len() > 1000)
        {
            return Err("Track metadata is too long");
        }
        if self
            .duration_seconds
            .is_some_and(|value| !value.is_finite() || !(0.0..=86_400.0).contains(&value))
        {
            return Err("Track duration must be finite and between 0 and 86400 seconds");
        }
        if self
            .isrc
            .as_deref()
            .is_some_and(|value| !providers::valid_isrc(value))
        {
            return Err("Invalid ISRC");
        }
        if self.spotify_id.as_deref().is_some_and(|value| {
            value.len() != 22 || !value.bytes().all(|c| c.is_ascii_alphanumeric())
        }) || self.apple_music_id.as_deref().is_some_and(|value| {
            value.is_empty() || value.len() > 30 || !value.bytes().all(|c| c.is_ascii_digit())
        }) {
            return Err("Invalid streaming service ID");
        }
        Ok(())
    }

    fn title(&self) -> String {
        if self.version.trim().is_empty()
            || providers::normalized(&self.track_name)
                .contains(&providers::normalized(&self.version))
        {
            self.track_name.trim().to_owned()
        } else {
            format!("{} ({})", self.track_name.trim(), self.version.trim())
        }
    }

    fn duration_ms(&self) -> Option<u64> {
        self.duration_seconds
            .filter(|value| *value > 0.0)
            .map(|value| (value * 1000.0).round() as u64)
    }
}

/// Only rate-limit state is retained. Lyrics, misses and track metadata are never cached.
pub async fn fetch(
    client: &reqwest::Client,
    request: &LyricsRequest,
) -> Result<LyricsResponse, io::Error> {
    Ok(fetch_with(&ProviderClient::new(client), request).await)
}

async fn fetch_with(client: &ProviderClient<'_>, request: &LyricsRequest) -> LyricsResponse {
    let mut selection = Selection::default();
    for provider in [Provider::Amll, Provider::Red, Provider::Lrclib] {
        match client.fetch(provider, request).await {
            Ok(Some(lyrics)) => {
                if let Some(selected) = selection.consider(provider, lyrics) {
                    return selected;
                }
            }
            Ok(None) => {}
            Err(_) => selection.failed.push(provider.name()),
        }
    }
    selection.finish()
}

#[derive(Default)]
struct Selection {
    amll: Option<LyricsResponse>,
    red: Option<LyricsResponse>,
    lrclib: Option<LyricsResponse>,
    failed: Vec<&'static str>,
}

impl Selection {
    fn consider(
        &mut self,
        provider: Provider,
        mut lyrics: LyricsResponse,
    ) -> Option<LyricsResponse> {
        if lyrics.has_word_sync {
            lyrics.failed_providers = self.failed.clone();
            return Some(lyrics);
        }
        if lyrics.status == "unavailable" {
            return None;
        }
        match provider {
            Provider::Amll => self.amll = Some(lyrics),
            Provider::Red => self.red = Some(lyrics),
            Provider::Lrclib => self.lrclib = Some(lyrics),
        }
        None
    }

    fn finish(self) -> LyricsResponse {
        // Better timing wins; between equals, LRCLIB, then lrc.red, then AMLL.
        let mut lyrics = [self.lrclib, self.red, self.amll]
            .into_iter()
            .flatten()
            .reduce(|best, next| {
                if providers::quality(&next) > providers::quality(&best) {
                    next
                } else {
                    best
                }
            })
            .unwrap_or_else(|| LyricsResponse::empty(None));
        lyrics.failed_providers = self.failed;
        lyrics
    }
}

#[cfg(test)]
#[path = "../tests/lyrics/regression.rs"]
mod tests;
