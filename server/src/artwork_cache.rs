use std::{
    collections::VecDeque,
    sync::{Arc, Weak},
};

use bytes::Bytes;
use tokio::sync::{Mutex, OnceCell, Semaphore};

use crate::artwork_quality::{dominant_colors, trusted_artwork_url};

const CAPACITY: usize = 512;
const MAX_DOWNLOAD: usize = 16 * 1024 * 1024;

pub(crate) struct Artwork {
    pub bytes: Bytes,
    colors: OnceCell<Vec<String>>,
}

impl Artwork {
    pub async fn colors(&self) -> Vec<String> {
        self.colors
            .get_or_init(|| async {
                let bytes = self.bytes.clone();
                tokio::task::spawn_blocking(move || dominant_colors(&bytes).unwrap_or_default())
                    .await
                    .unwrap_or_default()
            })
            .await
            .clone()
    }
}

/// Normal covers and background analysis share one thumbnail download/decode.
/// The browser also persists these public, URL-addressed thumbnails in its HTTP cache.
pub(crate) struct ArtworkCache {
    client: reqwest::Client,
    entries: Mutex<VecDeque<(String, Arc<Artwork>)>>,
    fetches: Mutex<std::collections::HashMap<String, Weak<Mutex<()>>>>,
    slots: Semaphore,
}

impl ArtworkCache {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            entries: Mutex::new(VecDeque::new()),
            fetches: Mutex::new(Default::default()),
            slots: Semaphore::new(4),
        }
    }

    async fn cached(&self, url: &str) -> Option<Arc<Artwork>> {
        let mut entries = self.entries.lock().await;
        let index = entries.iter().position(|(key, _)| key == url)?;
        let entry = entries.remove(index)?;
        let artwork = entry.1.clone();
        entries.push_back(entry);
        Some(artwork)
    }

    pub async fn get(&self, provider: &str, url: &str) -> Result<Arc<Artwork>, String> {
        if !trusted_artwork_url(provider, url) {
            return Err("Artwork URL does not belong to the selected provider".into());
        }
        self.load(&thumbnail_source(provider, url)).await
    }

    async fn load(&self, url: &str) -> Result<Arc<Artwork>, String> {
        if let Some(artwork) = self.cached(url).await {
            return Ok(artwork);
        }
        let lock = {
            let mut fetches = self.fetches.lock().await;
            fetches.retain(|_, lock| lock.strong_count() > 0);
            fetches
                .entry(url.to_owned())
                .or_default()
                .upgrade()
                .unwrap_or_else(|| {
                    let lock = Arc::new(Mutex::new(()));
                    fetches.insert(url.to_owned(), Arc::downgrade(&lock));
                    lock
                })
        };
        let _guard = lock.lock().await;
        if let Some(artwork) = self.cached(url).await {
            return Ok(artwork);
        }
        // Bound speculative scrolling work independently of audio connections.
        let _slot = self.slots.acquire().await.map_err(|e| e.to_string())?;
        let mut response = self
            .client
            .get(url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > MAX_DOWNLOAD {
                return Err("Artwork is too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let bytes = tokio::task::spawn_blocking(move || make_thumbnail(&bytes))
            .await
            .map_err(|e| e.to_string())??;
        let artwork = Arc::new(Artwork {
            bytes,
            colors: OnceCell::new(),
        });
        let mut entries = self.entries.lock().await;
        entries.push_back((url.to_owned(), artwork.clone()));
        while entries.len() > CAPACITY {
            entries.pop_front();
        }
        Ok(artwork)
    }
}

fn make_thumbnail(bytes: &[u8]) -> Result<Bytes, String> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    reader.limits(limits);
    let small = reader
        .decode()
        .map_err(|e| e.to_string())?
        .thumbnail(256, 256)
        .to_rgb8();
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, 90)
        .encode_image(&small)
        .map_err(|e| e.to_string())?;
    Ok(Bytes::from(encoded))
}

fn thumbnail_source(provider: &str, url: &str) -> String {
    let Some((base, filename)) = url.rsplit_once('/') else {
        return url.to_owned();
    };
    if provider == "tidal" && filename.ends_with(".jpg") {
        return format!("{base}/320x320.jpg");
    }
    if provider == "qobuz" {
        if let Some((stem, _)) = filename.rsplit_once('_') {
            return format!("{base}/{stem}_300.jpg");
        }
    }
    url.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_uses_provider_thumbnail_variants() {
        assert_eq!(
            thumbnail_source(
                "tidal",
                "https://resources.tidal.com/images/id/1280x1280.jpg"
            ),
            "https://resources.tidal.com/images/id/320x320.jpg"
        );
        assert_eq!(
            thumbnail_source("qobuz", "https://static.qobuz.com/images/id_max.jpg"),
            "https://static.qobuz.com/images/id_300.jpg"
        );
        assert_eq!(
            thumbnail_source("spotify", "https://i.scdn.co/image/id"),
            "https://i.scdn.co/image/id"
        );
    }

    #[tokio::test]
    async fn concurrent_covers_and_palettes_share_one_download() {
        use axum::{Router, routing::get};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut input = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(800, 800, image::Rgb([190, 80, 40]))
            .write_to(&mut input, image::ImageFormat::Png)
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let bytes = Bytes::from(input.into_inner());
        let app = Router::new().route(
            "/cover",
            get(move || {
                let bytes = bytes.clone();
                count.fetch_add(1, Ordering::SeqCst);
                async move { bytes }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/cover", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let cache = ArtworkCache::new(reqwest::Client::new());
        let started = std::time::Instant::now();
        let results = futures_util::future::join_all((0..10).map(|_| cache.load(&url))).await;
        let cold = started.elapsed();
        let first = results[0].as_ref().unwrap();
        for result in &results {
            assert!(Arc::ptr_eq(first, result.as_ref().unwrap()));
        }
        let (left, right) = tokio::join!(first.colors(), first.colors());
        assert_eq!(left, right);
        assert_eq!(left.len(), 4);
        assert_eq!(image::load_from_memory(&first.bytes).unwrap().width(), 256);
        let started = std::time::Instant::now();
        cache.load(&url).await.unwrap();
        eprintln!(
            "Artwork: 10 concurrent consumers {cold:?}; warm {:?}; upstream downloads {}",
            started.elapsed(),
            calls.load(Ordering::SeqCst)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.abort();
    }
}
