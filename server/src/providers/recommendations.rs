use std::{
    future::Future,
    time::{Duration, Instant},
};

use serde::Serialize;
use tokio::sync::Mutex;

use crate::models::{CatalogAlbum, TrackMetadata};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mix {
    pub id: String,
    pub title: String,
    pub image_url: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub artwork_fallback: bool,
    pub section: &'static str,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixArtwork {
    pub image_url: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub album_image_urls: Vec<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendations {
    pub mixes: Vec<Mix>,
    pub albums: Vec<CatalogAlbum>,
}

type Contents = (String, Instant, Vec<TrackMetadata>);

/// Shared by clones of one authenticated session and discarded when it is replaced.
#[derive(Default)]
pub struct Cache {
    recommendations: Mutex<Option<(Instant, Recommendations)>>,
    contents: Mutex<Vec<Contents>>,
}

pub const TTL: Duration = Duration::from_secs(10 * 60);

/// A single provider-session value. Concurrent callers share the same load.
pub struct Cached<T, K = ()>(Mutex<Option<(K, Instant, T)>>);

impl<T, K> Default for Cached<T, K> {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

impl<T: Clone, K: PartialEq> Cached<T, K> {
    pub async fn get_or_load<E>(
        &self,
        key: K,
        load: impl Future<Output = Result<T, E>>,
        ttl: impl FnOnce(&T) -> Duration,
    ) -> Result<T, E> {
        let mut cached = self.0.lock().await;
        if let Some((_, _, value)) = cached
            .as_ref()
            .filter(|(cached_key, expires, _)| *cached_key == key && *expires > Instant::now())
        {
            return Ok(value.clone());
        }
        let value = load.await?;
        *cached = Some((key, Instant::now() + ttl(&value), value.clone()));
        Ok(value)
    }
}

impl Cache {
    pub async fn recommendations<E>(
        &self,
        load: impl Future<Output = Result<Recommendations, E>>,
    ) -> Result<Recommendations, E> {
        let mut cached = self.recommendations.lock().await;
        if let Some((_, value)) = cached.as_ref().filter(|(at, _)| at.elapsed() < TTL) {
            return Ok(value.clone());
        }
        let value = load.await?;
        *cached = Some((Instant::now(), value.clone()));
        Ok(value)
    }

    pub async fn tracks<E>(
        &self,
        id: &str,
        load: impl Future<Output = Result<Vec<TrackMetadata>, E>>,
    ) -> Result<Vec<TrackMetadata>, E> {
        let mut cached = self.contents.lock().await;
        cached.retain(|(_, at, _)| at.elapsed() < TTL);
        if let Some((_, _, tracks)) = cached.iter().find(|(key, _, _)| key == id) {
            return Ok(tracks.clone());
        }
        let tracks = load.await?;
        if !tracks.is_empty() {
            if cached.len() >= 16 {
                cached.remove(0);
            }
            cached.push((id.to_owned(), Instant::now(), tracks.clone()));
        }
        Ok(tracks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn concurrent_reads_share_success_only_within_their_session() {
        let cache = Cache::default();
        let fetches = std::sync::atomic::AtomicUsize::new(0);
        let load = || async {
            fetches.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            tokio::task::yield_now().await;
            Ok::<_, ()>(Recommendations::default())
        };
        let (first, second) =
            tokio::join!(cache.recommendations(load()), cache.recommendations(load()));
        assert!(first.is_ok() && second.is_ok());
        assert_eq!(fetches.load(std::sync::atomic::Ordering::Relaxed), 1);
        let replacement = Cache::default();
        assert!(
            replacement
                .recommendations(async { Err::<Recommendations, _>(()) })
                .await
                .is_err()
        );
        assert!(replacement.recommendations(load()).await.is_ok());
        assert_eq!(fetches.load(std::sync::atomic::Ordering::Relaxed), 2);
    }
}
