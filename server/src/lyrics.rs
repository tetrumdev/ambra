mod formats;
mod model;
mod providers;
mod ttml;
mod vocal;

pub use model::LyricsResponse;
pub use vocal::refine as refine_with_vocals;
use providers::{Provider, ProviderClient};
use futures_util::{FutureExt, future::{BoxFuture, Shared, WeakShared}};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, future::Future, sync::{Arc, Mutex}};

#[derive(Clone, Deserialize, Serialize)]
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
    /// The recording the lyrics are for, so the server can analyze its vocals.
    pub provider: Option<String>,
    pub track_id: Option<String>,
    /// One lyrics provider the listener chose for this song, asked alone instead of all of them.
    source: Option<String>,
    /// Asked ahead of playback; its analysis waits behind songs playing now.
    #[serde(default)]
    pub prefetch: bool,
}

impl LyricsRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.track_name.trim().is_empty() || self.artist_name.trim().is_empty() {
            return Err("Track title and artist are required");
        }
        if self.provider.as_deref().is_some_and(|provider| !["tidal", "qobuz", "spotify", "local"].contains(&provider))
            || self.track_id.as_deref().is_some_and(|id| {
                id.is_empty() || id.len() > 200 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
            })
        {
            return Err("Invalid track reference");
        }
        if self.source.as_deref().is_some_and(|source| {
            ![Provider::Amll, Provider::Red, Provider::Lrclib].iter().any(|provider| provider.name() == source)
        }) {
            return Err("Unknown lyrics source");
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

type Lookup = Shared<BoxFuture<'static, Arc<LyricsResponse>>>;

/// Shares overlapping requests without retaining lyrics or misses after delivery.
#[derive(Default)]
pub struct Lookups(Mutex<HashMap<String, WeakShared<BoxFuture<'static, Arc<LyricsResponse>>>>>);

impl Lookups {
    pub async fn fetch(&self, client: &reqwest::Client, request: LyricsRequest) -> Arc<LyricsResponse> {
        let key = serde_json::to_string(&request).expect("validated lyrics request");
        let client = client.clone();
        self.join(key, async move {
            Arc::new(fetch_with(&ProviderClient::new(&client), &request).await)
        }).await
    }

    fn join(&self, key: String, work: impl Future<Output = Arc<LyricsResponse>> + Send + 'static) -> Lookup {
        let mut active = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(pending) = active.get(&key).and_then(WeakShared::upgrade) {
            return pending;
        }
        active.retain(|_, pending| pending.upgrade().is_some());
        let lookup = work.boxed().shared();
        active.insert(key, lookup.downgrade().unwrap());
        lookup
    }
}

async fn fetch_with(client: &ProviderClient<'_>, request: &LyricsRequest) -> LyricsResponse {
    let mut selection = Selection::default();
    for provider in [Provider::Amll, Provider::Red, Provider::Lrclib] {
        if request.source.as_deref().is_some_and(|source| source != provider.name()) {
            continue;
        }
        match client.fetch(provider, request).await {
            Ok(Some(lyrics)) => {
                selection.answered = true;
                if let Some(selected) = selection.consider(provider, lyrics) {
                    return selected;
                }
            }
            Ok(None) => selection.answered = true,
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
    answered: bool,
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
        // A miss is only a failure when no provider could be asked at all. LRCLIB in particular
        // answers most misses with 503 "ServerOverloaded", so one failed provider beside others
        // that found nothing still means the song has no lyrics, not that the lookup broke.
        if lyrics.status != "unavailable" || !self.answered {
            lyrics.failed_providers = self.failed;
        }
        lyrics
    }
}


#[cfg(test)]
mod lookup_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn overlapping_lyrics_requests_run_one_lookup_without_retaining_the_result() {
        let lookups = Lookups::default();
        let count = Arc::new(AtomicUsize::new(0));
        let request = || {
            let count = count.clone();
            lookups.join("same request".into(), async move {
                count.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
                Arc::new(LyricsResponse::empty(None))
            })
        };
        let results = futures_util::future::join_all((0..20).map(|_| request())).await;
        assert_eq!(count.load(Ordering::Relaxed), 1);
        assert!(results.iter().all(|result| Arc::ptr_eq(result, &results[0])));
        request().await;
        assert_eq!(count.load(Ordering::Relaxed), 2);
        // The weak registry does not keep a cancelled request running.
        drop(request());
        request().await;
        assert_eq!(count.load(Ordering::Relaxed), 3);
    }
}
