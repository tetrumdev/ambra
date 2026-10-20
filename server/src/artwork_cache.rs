use std::{
    collections::VecDeque,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{
        Arc, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime},
};

use bytes::Bytes;
use tokio::sync::{Mutex, OnceCell, Semaphore};

use crate::artwork_quality::{ArtworkPalette, dominant_palette, trusted_artwork_url};

const CAPACITY: usize = 512;
const MAX_DOWNLOAD: usize = 16 * 1024 * 1024;
// Thumbnails are ~15 KB, so this holds tens of thousands of covers.
const MAX_DISK_BYTES: u64 = 256 * 1024 * 1024;
const PRUNE_DELAY: Duration = Duration::from_secs(45);
const TOUCH_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) struct Artwork {
    pub bytes: Bytes,
    colors: OnceCell<ArtworkPalette>,
    colors_path: Option<PathBuf>,
}

impl Artwork {
    /// Palettes are derived once per cover and persisted beside the thumbnail,
    /// so a restart (or a cover seen weeks ago) never recomputes them.
    pub async fn colors(&self) -> Vec<String> {
        self.palette().await.colors
    }

    pub async fn palette(&self) -> ArtworkPalette {
        self.colors
            .get_or_init(|| async {
                let bytes = self.bytes.clone();
                let path = self.colors_path.clone();
                tokio::task::spawn_blocking(move || {
                    let colors = dominant_palette(&bytes).unwrap_or_default();
                    if let (Some(path), false) = (path, colors.colors.is_empty())
                        && let Ok(encoded) = serde_json::to_vec(&colors)
                    {
                        let _ = write_atomic(&path, &encoded);
                    }
                    colors
                })
                .await
                .unwrap_or_default()
            })
            .await
            .clone()
    }
}

fn entry_paths(directory: &Path, url: &str) -> (PathBuf, PathBuf) {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    let key = format!("{:016x}-{:x}", hasher.finish(), url.len());
    (
        directory.join(format!("{key}.jpg")),
        directory.join(format!("{key}.colors-v3.json")),
    )
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

fn store_thumbnail(directory: &Path, url: &str, bytes: &[u8]) {
    let (thumbnail, _) = entry_paths(directory, url);
    if let Err(error) = write_atomic(&thumbnail, bytes) {
        eprintln!("Could not cache artwork on disk: {error}");
    }
}

fn read_from_disk(directory: &Path, url: &str) -> Option<Artwork> {
    let (thumbnail, colors_path) = entry_paths(directory, url);
    let bytes = fs::read(&thumbnail).ok().filter(|bytes| !bytes.is_empty())?;
    // Recently used entries survive pruning; avoid a metadata write on every hit.
    if fs::metadata(&thumbnail)
        .and_then(|metadata| metadata.modified())
        .is_ok_and(|modified| modified.elapsed().is_ok_and(|age| age > TOUCH_AFTER))
    {
        let now = SystemTime::now();
        for path in [&thumbnail, &colors_path] {
            if let Ok(file) = fs::File::options().write(true).open(path) {
                let _ = file.set_modified(now);
            }
        }
    }
    let colors = fs::read(&colors_path)
        .ok()
        .and_then(|encoded| serde_json::from_slice::<ArtworkPalette>(&encoded).ok())
        .filter(|palette| palette.colors.len() == 4 && palette.weights.len() == 4);
    Some(Artwork {
        bytes: Bytes::from(bytes),
        colors: OnceCell::new_with(colors),
        colors_path: Some(colors_path),
    })
}

/// Delete the least recently used files until the directory fits in `max_bytes`
/// (down to 80% of it, so pruning is not re-triggered by every new cover).
pub(crate) fn prune_directory(directory: &Path, max_bytes: u64) -> usize {
    let Ok(listing) = fs::read_dir(directory) else {
        return 0;
    };
    let mut files: Vec<_> = listing
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| {
                (
                    metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    metadata.len(),
                    entry.path(),
                )
            })
        })
        .collect();
    let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
    if total <= max_bytes {
        return 0;
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    let target = max_bytes / 10 * 8;
    let mut removed = 0;
    for (_, size, path) in files {
        if total <= target {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
            removed += 1;
        }
    }
    removed
}

/// Normal covers and background analysis share one thumbnail download/decode.
/// The browser also persists these public, URL-addressed thumbnails in its HTTP cache.
pub(crate) struct ArtworkCache {
    client: reqwest::Client,
    entries: Mutex<VecDeque<(String, Arc<Artwork>)>>,
    fetches: Mutex<std::collections::HashMap<String, Weak<Mutex<()>>>>,
    slots: Semaphore,
    disk: Option<PathBuf>,
}

impl ArtworkCache {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            entries: Mutex::new(VecDeque::new()),
            fetches: Mutex::new(Default::default()),
            slots: Semaphore::new(4),
            disk: None,
        }
    }

    /// Like `new`, but thumbnails and palettes also persist in `directory`, so
    /// covers render after a restart (or with the network down) without any
    /// download or recomputation. Must be called inside a Tokio runtime.
    pub fn with_disk(client: reqwest::Client, directory: PathBuf) -> Self {
        let pruned = directory.clone();
        tokio::spawn(async move {
            tokio::time::sleep(PRUNE_DELAY).await;
            let _ = tokio::task::spawn_blocking(move || prune_directory(&pruned, MAX_DISK_BYTES))
                .await;
        });
        Self {
            disk: Some(directory),
            ..Self::new(client)
        }
    }

    async fn remember(&self, url: &str, artwork: Arc<Artwork>) {
        let mut entries = self.entries.lock().await;
        entries.push_back((url.to_owned(), artwork));
        while entries.len() > CAPACITY {
            entries.pop_front();
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
        if let Some(directory) = self.disk.clone() {
            let key = url.to_owned();
            let stored = tokio::task::spawn_blocking(move || read_from_disk(&directory, &key))
                .await
                .ok()
                .flatten();
            if let Some(artwork) = stored {
                let artwork = Arc::new(artwork);
                self.remember(url, artwork.clone()).await;
                return Ok(artwork);
            }
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
        let disk = self.disk.clone();
        let key = url.to_owned();
        let bytes = tokio::task::spawn_blocking(move || {
            let thumbnail = make_thumbnail(&bytes)?;
            if let Some(directory) = disk {
                store_thumbnail(&directory, &key, &thumbnail);
            }
            Ok::<_, String>(thumbnail)
        })
        .await
        .map_err(|e| e.to_string())??;
        let artwork = Arc::new(Artwork {
            bytes,
            colors: OnceCell::new(),
            colors_path: self
                .disk
                .as_ref()
                .map(|directory| entry_paths(directory, url).1),
        });
        self.remember(url, artwork.clone()).await;
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
        if let Some((stem, size)) = filename.rsplit_once('_') {
            // Artist portraits can contain underscores but have no album-size variants.
            if size == "max.jpg"
                || size.strip_suffix(".jpg").is_some_and(|size| {
                    !size.is_empty() && size.chars().all(|c| c.is_ascii_digit())
                })
            {
                return format!("{base}/{stem}_300.jpg");
            }
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
        assert_eq!(
            thumbnail_source(
                "qobuz",
                "https://static.qobuz.com/images/artists/artist_portrait.jpg"
            ),
            "https://static.qobuz.com/images/artists/artist_portrait.jpg"
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ambra-artwork-{name}-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn covers_and_palettes_survive_a_restart_without_the_network() {
        use axum::{Router, routing::get};
        use std::sync::atomic::AtomicUsize;
        let mut input = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(600, 600, image::Rgb([30, 140, 200]))
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
        let directory = scratch("restart");

        let first = ArtworkCache::with_disk(reqwest::Client::new(), directory.clone());
        let artwork = first.load(&url).await.unwrap();
        let colors = artwork.colors().await;
        let palette = artwork.palette().await;
        assert_eq!(colors.len(), 4);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // A brand-new cache (a restart) with the upstream gone entirely.
        server.abort();
        let second = ArtworkCache::with_disk(reqwest::Client::new(), directory.clone());
        let started = std::time::Instant::now();
        let restored = second.load(&url).await.unwrap();
        let load_time = started.elapsed();
        assert_eq!(restored.bytes, artwork.bytes);
        let started = std::time::Instant::now();
        assert_eq!(restored.colors().await, colors);
        assert_eq!(restored.palette().await, palette);
        eprintln!(
            "Artwork after restart: thumbnail {load_time:?}, palette {:?}, upstream downloads {}",
            started.elapsed(),
            calls.load(Ordering::SeqCst)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1, "no second download");
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn old_palettes_refresh_using_the_existing_thumbnail() {
        let directory = scratch("weighted-palette");
        let url = "https://i.scdn.co/image/old-cover";
        let (thumbnail, colors_path) = entry_paths(&directory, url);
        let mut encoded = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(64, 64, image::Rgb([30, 90, 150]))
            .write_to(&mut encoded, image::ImageFormat::Png)
            .unwrap();
        fs::write(&thumbnail, encoded.into_inner()).unwrap();
        let legacy_path = PathBuf::from(
            colors_path
                .to_string_lossy()
                .replace(".colors-v3.json", ".colors.json"),
        );
        fs::write(
            legacy_path,
            br##"["#ffff00","#ffff00","#ffff00","#ffff00"]"##,
        )
        .unwrap();
        let palette = read_from_disk(&directory, url).unwrap().palette().await;
        assert_eq!(palette.colors, vec!["#1e5a96"; 4]);
        assert_eq!(palette.weights, [1.0, 0.0, 0.0, 0.0]);
        assert!(colors_path.exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn pruning_removes_least_recently_used_files_first() {
        let directory = scratch("prune");
        for index in 0..10u8 {
            let path = directory.join(format!("{index}.jpg"));
            fs::write(&path, vec![index; 100]).unwrap();
            let age = Duration::from_secs(1000 - u64::from(index) * 10);
            let file = fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(SystemTime::now() - age).unwrap();
        }
        assert_eq!(prune_directory(&directory, 5_000), 0, "under the limit");
        // 1000 bytes, limit 500 => shrink to 400: drop the six oldest.
        assert_eq!(prune_directory(&directory, 500), 6);
        let mut left: Vec<_> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["6.jpg", "7.jpg", "8.jpg", "9.jpg"]);
        let _ = fs::remove_dir_all(directory);
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
