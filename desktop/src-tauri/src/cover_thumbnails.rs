//! Small derived copies of local cover art.
//!
//! Lists, queues and the compact player display covers at ~76 px, but the
//! WebView decodes the whole source image to do that: a 3000 px embedded JPEG is
//! about 36 MB of decoded pixels per cover, and the UI keeps hundreds alive. A
//! 512 px JPEG decodes to about 1 MB and is sharp on high-DPI displays.
//!
//! Thumbnails are generated once per distinct source image (keyed by path, size
//! and modification time) and then only looked up.

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub const THUMBNAIL_PIXELS: u32 = 512;
const JPEG_QUALITY: u8 = 85;
// Refuse absurd images rather than allocating for them.
const MAX_DIMENSION: u32 = 20_000;
const MAX_DECODE_BYTES: u64 = 768 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum ThumbnailState {
    /// A thumbnail exists at this path.
    Ready(PathBuf),
    /// The source is unsupported, unreadable, or already small; use it directly.
    Skip,
    /// Not generated yet.
    Missing,
}

fn supported(source: &Path) -> bool {
    source
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png"
            )
        })
}

/// `(thumbnail, skip marker)` for a source image, or `None` if it cannot be stat'ed.
fn cache_paths(covers: &Path, source: &Path) -> Option<(PathBuf, PathBuf)> {
    let metadata = std::fs::metadata(source).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    let key = format!("{:016x}.{THUMBNAIL_PIXELS}", hasher.finish());
    Some((
        covers.join("thumbnails").join(format!("{key}.jpg")),
        covers.join("thumbnails").join(format!("{key}.skip")),
    ))
}

pub fn state(covers: &Path, source: &Path) -> ThumbnailState {
    if !supported(source) {
        return ThumbnailState::Skip;
    }
    let Some((thumbnail, marker)) = cache_paths(covers, source) else {
        return ThumbnailState::Skip;
    };
    if thumbnail.is_file() {
        ThumbnailState::Ready(thumbnail)
    } else if marker.is_file() {
        ThumbnailState::Skip
    } else {
        ThumbnailState::Missing
    }
}

/// Decode, downscale, and store a thumbnail. CPU-heavy: call from a background
/// thread, never from a request path.
pub fn generate(covers: &Path, source: &Path) -> ThumbnailState {
    match state(covers, source) {
        ThumbnailState::Missing => {}
        settled => return settled,
    }
    let Some((thumbnail, marker)) = cache_paths(covers, source) else {
        return ThumbnailState::Skip;
    };
    match render(source) {
        Ok(Some(encoded)) => match crate::write_file_atomic(&thumbnail, &encoded) {
            Ok(()) => ThumbnailState::Ready(thumbnail),
            Err(error) => {
                eprintln!("Could not store cover thumbnail: {error}");
                ThumbnailState::Missing
            }
        },
        Ok(None) => {
            let _ = crate::write_file_atomic(&marker, b"");
            ThumbnailState::Skip
        }
        Err(error) => {
            eprintln!("Could not thumbnail {}: {error}", source.display());
            // Do not retry a corrupt image on every scan.
            let _ = crate::write_file_atomic(&marker, b"");
            ThumbnailState::Skip
        }
    }
}

/// `Ok(None)` means the image is already small enough to use as-is.
fn render(source: &Path) -> Result<Option<Vec<u8>>, String> {
    let open = || {
        image::ImageReader::open(source)
            .and_then(|reader| reader.with_guessed_format())
            .map_err(|error| error.to_string())
    };
    let (width, height) = open()?
        .into_dimensions()
        .map_err(|error| error.to_string())?;
    if width.max(height) <= THUMBNAIL_PIXELS {
        return Ok(None);
    }
    let mut reader = open()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let small = reader
        .decode()
        .map_err(|error| error.to_string())?
        .thumbnail(THUMBNAIL_PIXELS, THUMBNAIL_PIXELS)
        .to_rgb8();
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, JPEG_QUALITY)
        .encode_image(&small)
        .map_err(|error| error.to_string())?;
    Ok(Some(encoded))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::Instant};

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "ambra-thumb-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// A detailed image so JPEG/PNG encoding is not trivially tiny.
    fn write_image(path: &Path, side: u32, format: image::ImageFormat) {
        let picture = image::RgbImage::from_fn(side, side, |x, y| {
            image::Rgb([
                (x * 7 % 256) as u8,
                (y * 5 % 256) as u8,
                ((x ^ y) % 256) as u8,
            ])
        });
        picture.save_with_format(path, format).unwrap();
    }

    #[test]
    fn large_images_get_a_512px_thumbnail_once() {
        let root = scratch("large");
        let source = root.join("cover.png");
        write_image(&source, 1400, image::ImageFormat::Png);
        let covers = root.join("covers");

        assert_eq!(state(&covers, &source), ThumbnailState::Missing);
        let ThumbnailState::Ready(thumbnail) = generate(&covers, &source) else {
            panic!("expected a thumbnail");
        };
        let decoded = image::open(&thumbnail).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (512, 512));
        assert!(fs::metadata(&thumbnail).unwrap().len() < fs::metadata(&source).unwrap().len());

        // Settled: a second call does no work and returns the same file.
        assert_eq!(
            state(&covers, &source),
            ThumbnailState::Ready(thumbnail.clone())
        );
        assert_eq!(generate(&covers, &source), ThumbnailState::Ready(thumbnail));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn aspect_ratio_is_preserved() {
        let root = scratch("aspect");
        let source = root.join("wide.jpg");
        image::RgbImage::from_pixel(1600, 800, image::Rgb([10, 200, 90]))
            .save_with_format(&source, image::ImageFormat::Jpeg)
            .unwrap();
        let ThumbnailState::Ready(thumbnail) = generate(&root.join("covers"), &source) else {
            panic!("expected a thumbnail");
        };
        let decoded = image::open(thumbnail).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (512, 256));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn small_corrupt_and_unsupported_sources_are_skipped_without_retrying() {
        let root = scratch("skip");
        let covers = root.join("covers");

        let small = root.join("small.png");
        write_image(&small, 300, image::ImageFormat::Png);
        assert_eq!(generate(&covers, &small), ThumbnailState::Skip);
        assert_eq!(state(&covers, &small), ThumbnailState::Skip);

        let corrupt = root.join("broken.jpg");
        fs::write(&corrupt, b"not an image at all").unwrap();
        assert_eq!(generate(&covers, &corrupt), ThumbnailState::Skip);
        assert_eq!(state(&covers, &corrupt), ThumbnailState::Skip);

        let webp = root.join("cover.webp");
        fs::write(&webp, b"RIFF").unwrap();
        assert_eq!(state(&covers, &webp), ThumbnailState::Skip);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn replacing_the_source_invalidates_its_thumbnail() {
        let root = scratch("invalidate");
        let source = root.join("cover.png");
        let covers = root.join("covers");
        write_image(&source, 1000, image::ImageFormat::Png);
        assert!(matches!(
            generate(&covers, &source),
            ThumbnailState::Ready(_)
        ));

        write_image(&source, 1200, image::ImageFormat::Png);
        assert_eq!(state(&covers, &source), ThumbnailState::Missing);
        let _ = fs::remove_dir_all(root);
    }

    /// `cargo test --release --lib thumbnail_benchmark -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn thumbnail_benchmark() {
        let root = scratch("bench");
        let source = root.join("big.jpg");
        write_image(&source, 3000, image::ImageFormat::Jpeg);
        let source_bytes = fs::metadata(&source).unwrap().len();
        let started = Instant::now();
        let ThumbnailState::Ready(thumbnail) = generate(&root.join("covers"), &source) else {
            panic!("expected a thumbnail");
        };
        println!(
            "3000x3000 JPEG ({} KB, ~{} MB decoded) -> 512px ({} KB, ~1 MB decoded) in {} ms",
            source_bytes / 1024,
            3000 * 3000 * 4 / 1_048_576,
            fs::metadata(thumbnail).unwrap().len() / 1024,
            started.elapsed().as_millis()
        );
        let _ = fs::remove_dir_all(root);
    }
}
