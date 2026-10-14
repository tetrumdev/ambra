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
