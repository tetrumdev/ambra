#![allow(unexpected_cfgs)] // objc 0.2 macros still probe the removed cargo-clippy cfg.

use lofty::{
    file::{AudioFile, TaggedFileExt},
    picture::PictureType,
    probe::read_from_path,
    tag::Accessor,
};
use oxideav_core::{ContainerRegistry, NullCodecResolver, ReadSeek};

use library_index::{FileStamp, IndexEntry};
use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::{self, File, OpenOptions},
    hash::{Hash, Hasher},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Instant, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use walkdir::WalkDir;

use bundled_backend::BundledBackend;

mod bundled_backend;
mod cover_thumbnails;
mod keyboard;
mod library_index;
mod media_controls;
mod native_audio;
mod persistence;
mod window_bounds;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    audio: String,
    cover: Option<String>,
    name: String,
    album: String,
    artist: String,
    track_number: Option<u32>,
    duration_seconds: f64,
    /// Small derived copy of `cover` for lists and grids; absent until generated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thumbnail: Option<String>,
}

const LIBRARY_INDEX_VERSION: u32 = 2;

#[derive(Deserialize)]
struct LibraryIndex {
    version: u32,
    entries: Vec<IndexEntry<Track>>,
}

#[derive(Serialize)]
struct LibraryIndexRef<'a> {
    version: u32,
    entries: &'a [IndexEntry<Track>],
}

fn cache_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate Ambra's cache directory: {error}"))
}

/// Pre-index cache: a flat list of tracks with base64 covers embedded.
fn legacy_library_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    cache_directory(app).map(|directory| directory.join("library.json"))
}

fn library_index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    cache_directory(app).map(|directory| directory.join("library-index.v2.json"))
}

fn persistent_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    env::var_os("AMBRA_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| app.path().app_data_dir().map(|path| path.join("data")))
        .map_err(|error| format!("Could not locate Ambra's data directory: {error}"))
}

// Persistence commands are `async` so Tauri runs them off the main thread, and
// they hop to the blocking pool for disk I/O (including fsync). A synchronous
// command would stall the window's event loop for the duration of every write.
#[tauri::command]
async fn load_persistent_state(
    app: tauri::AppHandle,
    known_updated_at_ms: Option<u64>,
) -> Result<Option<persistence::LoadedState>, String> {
    let directory = persistent_data_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || persistence::load(&directory, known_updated_at_ms))
        .await
        .map_err(|error| format!("Could not load Ambra's desktop state: {error}"))?
}

#[tauri::command]
async fn save_persistent_state(
    app: tauri::AppHandle,
    patch: persistence::StatePatch,
) -> Result<(), String> {
    let directory = persistent_data_directory(&app)?;
    tauri::async_runtime::spawn_blocking(move || persistence::save(&directory, patch))
        .await
        .map_err(|error| format!("Could not save Ambra's desktop state: {error}"))?
}

fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create {}: {error}", directory.display()))?;
    let temporary_id = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary_path =
        path.with_extension(format!("{}.{}.tmp", std::process::id(), temporary_id));
    fs::write(&temporary_path, bytes)
        .map_err(|error| format!("Could not write {}: {error}", temporary_path.display()))?;
    fs::rename(&temporary_path, path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        format!("Could not replace {}: {error}", path.display())
    })
}

fn read_library_index(path: &Path) -> Vec<IndexEntry<Track>> {
    let Ok(encoded) = fs::read(path) else {
        return Vec::new();
    };
    match serde_json::from_slice::<LibraryIndex>(&encoded) {
        Ok(index) if index.version == LIBRARY_INDEX_VERSION => index.entries,
        Ok(_) => Vec::new(),
        Err(error) => {
            eprintln!("Could not decode library index {}: {error}", path.display());
            Vec::new()
        }
    }
}

fn save_library_index(path: &Path, entries: &[IndexEntry<Track>]) -> Result<(), String> {
    let encoded = serde_json::to_vec(&LibraryIndexRef {
        version: LIBRARY_INDEX_VERSION,
        entries,
    })
    .map_err(|error| format!("Could not encode the library index: {error}"))?;
    write_file_atomic(path, &encoded)
}

fn streaming_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    cache_directory(app).map(|directory| directory.join("streaming-library.json"))
}

// The streaming-library cache is a copy of what the Ambra server already owns, so
// it lives in the rebuildable cache directory rather than in `localStorage` (size
// limited, and synchronous on the UI thread) or the synchronized data directory.
#[tauri::command]
async fn load_streaming_cache(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = streaming_cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || match fs::read_to_string(&path) {
        Ok(encoded) => Ok(Some(encoded)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    })
    .await
    .map_err(|error| format!("Could not load the streaming library cache: {error}"))?
}

#[tauri::command]
async fn save_streaming_cache(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = streaming_cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_file_atomic(&path, json.as_bytes()))
        .await
        .map_err(|error| format!("Could not save the streaming library cache: {error}"))?
}

fn service_playlist_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    cache_directory(app).map(|directory| directory.join("service-playlists.json"))
}

// Streaming-service playlists are copies of what each service owns, cached for the
// same reasons as the streaming library so they open without a network round trip.
#[tauri::command]
async fn load_service_playlist_cache(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = service_playlist_cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || match fs::read_to_string(&path) {
        Ok(encoded) => Ok(Some(encoded)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    })
    .await
    .map_err(|error| format!("Could not load the playlist cache: {error}"))?
}

#[tauri::command]
async fn save_service_playlist_cache(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = service_playlist_cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || write_file_atomic(&path, json.as_bytes()))
        .await
        .map_err(|error| format!("Could not save the playlist cache: {error}"))?
}

#[tauri::command]
async fn load_cached_music(app: tauri::AppHandle) -> Result<Vec<Track>, String> {
    tauri::async_runtime::spawn_blocking(move || load_cached_music_blocking(&app))
        .await
        .map_err(|error| format!("Could not load the library cache: {error}"))?
}

fn load_cached_music_blocking(app: &tauri::AppHandle) -> Result<Vec<Track>, String> {
    let index = read_library_index(&library_index_path(app)?);
    if !index.is_empty() {
        return Ok(index.into_iter().map(|entry| entry.track).collect());
    }

    // First launch after upgrading: show the old cache until the scan writes the index.
    let legacy_path = legacy_library_cache_path(app)?;
    let encoded = match fs::read(&legacy_path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not read library cache {}: {error}",
                legacy_path.display()
            ));
        }
    };
    serde_json::from_slice(&encoded).map_err(|error| {
        format!(
            "Could not decode library cache {}: {error}",
            legacy_path.display()
        )
    })
}

struct FlacLayout {
    first_frame_offset: u64,
    last_header_offset: usize,
    has_seektable: bool,
    sample_rate: u32,
    padding_blocks: Vec<(u64, usize, bool)>,
}

fn read_flac_layout(path: &Path) -> Result<FlacLayout, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let mut marker = [0_u8; 4];
    file.read_exact(&mut marker)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if &marker != b"fLaC" {
        return Err(format!("{} is not a native FLAC file", path.display()));
    }

    let mut has_seektable = false;
    let mut sample_rate = None;
    let mut padding_blocks = Vec::new();
    let last_header_offset;

    loop {
        let header_offset = file
            .stream_position()
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        let mut header = [0_u8; 4];
        file.read_exact(&mut header)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;

        let is_last = header[0] & 0x80 != 0;
        let block_type = header[0] & 0x7f;
        let block_length = u32::from_be_bytes([0, header[1], header[2], header[3]]) as usize;

        if block_type == 0 {
            if block_length != 34 {
                return Err(format!(
                    "{} has an invalid FLAC STREAMINFO block",
                    path.display()
                ));
            }
            let mut streaminfo = [0_u8; 34];
            file.read_exact(&mut streaminfo)
                .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
            let packed = u64::from_be_bytes(
                streaminfo[10..18]
                    .try_into()
                    .expect("STREAMINFO slice has a fixed length"),
            );
            sample_rate = Some((packed >> 44) as u32);
        } else {
            file.seek(SeekFrom::Current(block_length as i64))
                .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        }

        has_seektable |= block_type == 3;
        if block_type == 1 {
            padding_blocks.push((header_offset, block_length, is_last));
        }
        if is_last {
            last_header_offset = header_offset as usize;
            break;
        }
    }

    let first_frame_offset = file
        .stream_position()
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;

    Ok(FlacLayout {
        first_frame_offset,
        last_header_offset,
        has_seektable,
        sample_rate: sample_rate
            .filter(|rate| *rate > 0)
            .ok_or_else(|| format!("{} has no valid FLAC sample rate", path.display()))?,
        padding_blocks,
    })
}

fn flac_seektable(
    path: &Path,
    sample_rate: u32,
    expected_frame_bytes: u64,
) -> Result<Vec<u8>, String> {
    let input: Box<dyn ReadSeek> = Box::new(
        File::open(path).map_err(|error| format!("Could not open {}: {error}", path.display()))?,
    );
    let mut registry = ContainerRegistry::new();
    oxideav_flac::register_containers(&mut registry);
    let mut demuxer = registry
        .open_demuxer("flac", input, &NullCodecResolver)
        .map_err(|error| format!("Could not parse FLAC frames in {}: {error}", path.display()))?;

    let interval = u64::from(sample_rate) * 5;
    let mut next_sample = 0_u64;
    let mut byte_offset = 0_u64;
    let mut points = Vec::new();

    while let Ok(packet) = demuxer.next_packet() {
        let sample_number = packet.pts.unwrap_or(0).max(0) as u64;
        let frame_samples = packet.duration.unwrap_or(0).max(0) as u16;

        if sample_number >= next_sample {
            points.extend_from_slice(&sample_number.to_be_bytes());
            points.extend_from_slice(&byte_offset.to_be_bytes());
            points.extend_from_slice(&frame_samples.to_be_bytes());
            next_sample = sample_number.saturating_add(interval);
        }

        byte_offset = byte_offset.saturating_add(packet.data.len() as u64);
    }

    if points.is_empty() {
        return Err(format!("Could not find FLAC frames in {}", path.display()));
    }
    if byte_offset != expected_frame_bytes {
        return Err(format!(
            "Could not scan every FLAC frame in {} (found {byte_offset} of {expected_frame_bytes} bytes)",
            path.display()
        ));
    }
    if points.len() > 0x00ff_ffff {
        return Err(format!("Seek table is too large for {}", path.display()));
    }

    Ok(points)
}

fn seekable_flac(path: &Path, cache_directory: &Path) -> Result<PathBuf, String> {
    let layout = read_flac_layout(path)?;
    if layout.has_seektable {
        return Ok(path.to_path_buf());
    }

    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    3_u8.hash(&mut hasher);
    path.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    let cache_path = cache_directory.join(format!("{:016x}.flac", hasher.finish()));
    if cache_path.is_file() {
        if read_flac_layout(&cache_path).is_ok_and(|cached_layout| cached_layout.has_seektable) {
            return Ok(cache_path);
        }
        fs::remove_file(&cache_path).map_err(|error| {
            format!(
                "Could not replace invalid FLAC cache {}: {error}",
                cache_path.display()
            )
        })?;
    }

    fs::create_dir_all(cache_directory).map_err(|error| {
        format!(
            "Could not create FLAC cache {}: {error}",
            cache_directory.display()
        )
    })?;

    let seektable = flac_seektable(
        path,
        layout.sample_rate,
        metadata.len().saturating_sub(layout.first_frame_offset),
    )?;
    let temporary_id = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary_path =
        cache_path.with_extension(format!("flac.{}.{}.tmp", std::process::id(), temporary_id));
    let _ = fs::remove_file(&temporary_path);
    let write_result = (|| -> Result<(), String> {
        if let Some(&(padding_offset, padding_length, padding_is_last)) = layout
            .padding_blocks
            .iter()
            .find(|(_, length, _)| *length >= seektable.len() + 4)
        {
            clone_or_copy(path, &temporary_path)?;
            let remaining_padding = padding_length - seektable.len() - 4;
            let mut destination = OpenOptions::new()
                .write(true)
                .open(&temporary_path)
                .map_err(|error| format!("Could not open {}: {error}", temporary_path.display()))?;
            destination
                .seek(SeekFrom::Start(padding_offset))
                .and_then(|_| {
                    destination.write_all(&[
                        0x03,
                        ((seektable.len() >> 16) & 0xff) as u8,
                        ((seektable.len() >> 8) & 0xff) as u8,
                        (seektable.len() & 0xff) as u8,
                    ])
                })
                .and_then(|()| destination.write_all(&seektable))
                .and_then(|()| {
                    destination.write_all(&[
                        if padding_is_last { 0x81 } else { 0x01 },
                        ((remaining_padding >> 16) & 0xff) as u8,
                        ((remaining_padding >> 8) & 0xff) as u8,
                        (remaining_padding & 0xff) as u8,
                    ])
                })
                .map_err(|error| {
                    format!("Could not update {}: {error}", temporary_path.display())
                })?;
            destination.sync_all().map_err(|error| {
                format!("Could not finish {}: {error}", temporary_path.display())
            })?;
        } else {
            let mut source = File::open(path)
                .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
            let mut metadata_prefix = vec![0_u8; layout.first_frame_offset as usize];
            source
                .read_exact(&mut metadata_prefix)
                .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
            metadata_prefix[layout.last_header_offset] &= 0x7f;

            let mut destination = File::create(&temporary_path).map_err(|error| {
                format!("Could not create {}: {error}", temporary_path.display())
            })?;
            destination
                .write_all(&metadata_prefix)
                .and_then(|()| {
                    destination.write_all(&[
                        0x83,
                        ((seektable.len() >> 16) & 0xff) as u8,
                        ((seektable.len() >> 8) & 0xff) as u8,
                        (seektable.len() & 0xff) as u8,
                    ])
                })
                .and_then(|()| destination.write_all(&seektable))
                .map_err(|error| {
                    format!("Could not write {}: {error}", temporary_path.display())
                })?;
            std::io::copy(&mut source, &mut destination)
                .map_err(|error| format!("Could not copy {}: {error}", path.display()))?;
            destination.sync_all().map_err(|error| {
                format!("Could not finish {}: {error}", temporary_path.display())
            })?;
        }

        if cache_path.is_file() {
            if read_flac_layout(&cache_path).is_ok_and(|cached_layout| cached_layout.has_seektable)
            {
                fs::remove_file(&temporary_path).map_err(|error| {
                    format!("Could not remove {}: {error}", temporary_path.display())
                })?;
                return Ok(());
            }
            fs::remove_file(&cache_path).map_err(|error| {
                format!(
                    "Could not replace invalid FLAC cache {}: {error}",
                    cache_path.display()
                )
            })?;
        }
        fs::rename(&temporary_path, &cache_path).map_err(|error| {
            format!(
                "Could not move {} to {}: {error}",
                temporary_path.display(),
                cache_path.display()
            )
        })?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result?;
    Ok(cache_path)
}

#[cfg(target_os = "macos")]
fn clone_or_copy(source: &Path, destination: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let source_c = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| format!("Source path contains a null byte: {}", source.display()))?;
    let destination_c = CString::new(destination.as_os_str().as_bytes()).map_err(|_| {
        format!(
            "Destination path contains a null byte: {}",
            destination.display()
        )
    })?;

    // SAFETY: Both C strings live through the call, are null-terminated, and point to valid paths.
    let cloned = unsafe { libc::clonefile(source_c.as_ptr(), destination_c.as_ptr(), 0) };
    if cloned == 0 {
        return Ok(());
    }

    fs::copy(source, destination).map(|_| ()).map_err(|error| {
        format!(
            "Could not clone {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

#[cfg(not(target_os = "macos"))]
fn clone_or_copy(source: &Path, destination: &Path) -> Result<(), String> {
    fs::copy(source, destination).map(|_| ()).map_err(|error| {
        format!(
            "Could not copy {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn is_supported_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mp3" | "m4a" | "mp4" | "flac" | "ogg" | "opus" | "wav" | "aiff" | "aif"
            )
        })
        .unwrap_or(false)
}

fn nearby_cover(path: &Path) -> Option<String> {
    let directory = path.parent()?;

    [
        "cover.jpg",
        "cover.jpeg",
        "cover.png",
        "folder.jpg",
        "folder.png",
    ]
    .into_iter()
    .map(|name| directory.join(name))
    .find(|candidate| candidate.is_file())
    .map(|candidate| candidate.to_string_lossy().into_owned())
}

fn folder_metadata(path: &Path, library_root: &Path) -> (Option<String>, Option<String>) {
    let relative_parent = path
        .parent()
        .and_then(|parent| parent.strip_prefix(library_root).ok());
    let folders: Vec<String> = relative_parent
        .into_iter()
        .flat_map(|parent| parent.components())
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();

    if folders.len() < 2 {
        return (None, None);
    }

    let album = folders.last().cloned();
    let artist = folders.get(folders.len() - 2).cloned();
    (artist, album)
}

fn cover_extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "jpg",
    }
}

/// Store an embedded cover once, addressed by its content. Every track of an
/// album embeds the same picture, so a library of N albums writes N files
/// instead of carrying one base64 copy per track through the JSON cache, the IPC
/// channel, and the WebView heap.
fn write_cover(covers: &Path, mime_type: &str, data: &[u8]) -> Result<String, String> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut hasher);
    let path = covers.join(format!(
        "{:016x}-{:x}.{}",
        hasher.finish(),
        data.len(),
        cover_extension(mime_type)
    ));
    if !path.is_file() {
        write_file_atomic(&path, data)?;
    }
    Ok(path.to_string_lossy().into_owned())
}

fn read_track(path: &Path, library_root: &Path, covers: &Path) -> Result<Track, String> {
    let tagged_file = read_from_path(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;

    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    let filename = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Unknown Track")
        .to_owned();
    let (folder_artist, folder_album) = folder_metadata(path, library_root);

    let embedded_cover = tag
        .and_then(|tag| {
            tag.pictures()
                .iter()
                .find(|picture| picture.pic_type() == PictureType::CoverFront)
                .or_else(|| tag.pictures().first())
        })
        .and_then(|picture| {
            let mime_type = picture
                .mime_type()
                .map(|mime_type| mime_type.as_str())
                .unwrap_or("image/jpeg");

            write_cover(covers, mime_type, picture.data())
                .map_err(|error| eprintln!("Could not cache embedded artwork: {error}"))
                .ok()
        });

    let duration_seconds = tagged_file.properties().duration().as_secs_f64();

    Ok(Track {
        audio: path.to_string_lossy().into_owned(),
        cover: embedded_cover.or_else(|| nearby_cover(path)),
        name: tag
            .and_then(|tag| tag.title())
            .map(|value| value.into_owned())
            .unwrap_or(filename),
        album: tag
            .and_then(|tag| tag.album())
            .map(|value| value.into_owned())
            .or(folder_album)
            .unwrap_or_else(|| "Unknown Album".to_owned()),
        artist: tag
            .and_then(|tag| tag.artist())
            .map(|value| value.into_owned())
            .or(folder_artist)
            .unwrap_or_else(|| "Unknown Artist".to_owned()),
        track_number: tag.and_then(|tag| tag.track()),
        duration_seconds,
        thumbnail: None,
    })
}

#[tauri::command]
fn local_music_directory(app: tauri::AppHandle) -> Result<String, String> {
    let music_directory = app
        .path()
        .audio_dir()
        .map_err(|error| format!("Could not locate the Music directory: {error}"))?
        .join("Ambra");
    std::fs::create_dir_all(&music_directory)
        .map_err(|error| format!("Could not create {}: {error}", music_directory.display()))?;
    Ok(music_directory.to_string_lossy().into_owned())
}

#[tauri::command]
async fn scan_music(app: tauri::AppHandle) -> Result<Vec<Track>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_music_blocking(&app))
        .await
        .map_err(|error| format!("Could not scan the music library: {error}"))?
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn collect_audio_files(root: &Path) -> Vec<FileStamp> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| match entry {
            Ok(entry) => Some(entry),
            Err(error) => {
                eprintln!("Could not scan a library entry: {error}");
                None
            }
        })
        .filter(|entry| entry.file_type().is_file() && is_supported_audio(entry.path()))
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            Some(FileStamp {
                path: entry.path().to_string_lossy().into_owned(),
                size: metadata.len(),
                modified_ms: modified_millis(&metadata),
            })
        })
        .collect()
}

/// An unchanged file can still need a re-read when the artifacts its track
/// points at (cached seekable FLAC, cover image) were deleted or have appeared.
fn indexed_entry_is_current(entry: &IndexEntry<Track>) -> bool {
    let track = &entry.track;
    if track.audio != entry.path && !Path::new(&track.audio).is_file() {
        return false;
    }
    match track.cover.as_deref() {
        Some(cover) if cover.starts_with("data:") => false,
        Some(cover) => Path::new(cover).is_file(),
        None => nearby_cover(Path::new(&entry.path)).is_none(),
    }
}

/// Keep background tag reading from competing with audio and the UI.
fn lower_scan_thread_priority() {
    #[cfg(target_os = "macos")]
    {
        thread_local!(static LOWERED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });
        LOWERED.with(|lowered| {
            if !lowered.replace(true) {
                // SAFETY: adjusts only the calling thread's scheduling class.
                unsafe {
                    libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
                }
            }
        });
    }
}

fn read_indexed_track(
    file: &FileStamp,
    library_root: &Path,
    flac_cache: &Path,
    covers: &Path,
) -> Option<Track> {
    lower_scan_thread_priority();
    let path = Path::new(&file.path);
    match read_track(path, library_root, covers) {
        Ok(mut track) => {
            if path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("flac"))
            {
                match seekable_flac(path, flac_cache) {
                    Ok(audio_path) => track.audio = audio_path.to_string_lossy().into_owned(),
                    Err(error) => eprintln!("{error}"),
                }
            }
            Some(track)
        }
        Err(error) => {
            eprintln!("{error}");
            None
        }
    }
}

fn scan_library(
    library_root: &Path,
    flac_cache: &Path,
    covers: &Path,
    previous: Vec<IndexEntry<Track>>,
    workers: usize,
) -> library_index::Reconciled<Track> {
    let files = collect_audio_files(library_root);
    let mut reconciled = library_index::reconcile(
        previous,
        &files,
        indexed_entry_is_current,
        |file| read_indexed_track(file, library_root, flac_cache, covers),
        workers,
    );
    reconciled.entries.sort_by_cached_key(|entry| {
        (
            entry.track.artist.to_lowercase(),
            entry.track.album.to_lowercase(),
            entry.track.track_number,
            entry.track.name.to_lowercase(),
        )
    });
    reconciled
}

// Serializes read-modify-write cycles of the library index between scans and the
// background thumbnail worker.
static INDEX_LOCK: Mutex<()> = Mutex::new(());
static THUMBNAIL_WORKER_RUNNING: AtomicBool = AtomicBool::new(false);
const THUMBNAIL_PUBLISH_BATCH: usize = 100;

/// Point each track at its cover thumbnail if one exists. Covers are shared by
/// whole albums, so each distinct cover is checked once. Returns whether any
/// track changed, and the distinct sources that still need a thumbnail.
fn attach_thumbnails(entries: &mut [IndexEntry<Track>], covers: &Path) -> (bool, Vec<PathBuf>) {
    let mut settled: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    let mut pending = Vec::new();
    let mut changed = false;
    for entry in entries {
        let Some(cover) = entry
            .track
            .cover
            .clone()
            .filter(|cover| !cover.starts_with("data:"))
        else {
            continue;
        };
        let thumbnail =
            settled.entry(cover.clone()).or_insert_with(|| {
                match cover_thumbnails::state(covers, Path::new(&cover)) {
                    cover_thumbnails::ThumbnailState::Ready(path) => {
                        Some(path.to_string_lossy().into_owned())
                    }
                    cover_thumbnails::ThumbnailState::Skip => None,
                    cover_thumbnails::ThumbnailState::Missing => {
                        pending.push(PathBuf::from(&cover));
                        None
                    }
                }
            });
        if entry.track.thumbnail != *thumbnail {
            entry.track.thumbnail.clone_from(thumbnail);
            changed = true;
        }
    }
    (changed, pending)
}

struct WorkerGuard;
impl Drop for WorkerGuard {
    fn drop(&mut self) {
        THUMBNAIL_WORKER_RUNNING.store(false, Ordering::Release);
    }
}

/// Generate missing thumbnails off the critical path: one low-priority thread,
/// results published in batches so covers improve progressively.
fn spawn_thumbnail_worker(app: tauri::AppHandle, pending: Vec<PathBuf>) {
    if pending.is_empty() || THUMBNAIL_WORKER_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("ambra-cover-thumbnails".to_owned())
        .spawn({
            let app = app.clone();
            move || {
                let _guard = WorkerGuard;
                lower_scan_thread_priority();
                let (Ok(index_path), Ok(cache)) = (library_index_path(&app), cache_directory(&app))
                else {
                    return;
                };
                let covers = cache.join("covers");
                for batch in pending.chunks(THUMBNAIL_PUBLISH_BATCH) {
                    for source in batch {
                        cover_thumbnails::generate(&covers, source);
                    }
                    let _lock = INDEX_LOCK
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    let mut entries = read_library_index(&index_path);
                    if attach_thumbnails(&mut entries, &covers).0 {
                        match save_library_index(&index_path, &entries) {
                            Ok(()) => {
                                let _ = app.emit("local-library-updated", ());
                            }
                            Err(error) => eprintln!("{error}"),
                        }
                    }
                }
            }
        });
    if spawned.is_err() {
        THUMBNAIL_WORKER_RUNNING.store(false, Ordering::Release);
    }
}

fn scan_music_blocking(app: &tauri::AppHandle) -> Result<Vec<Track>, String> {
    let started = Instant::now();
    let music_directory: PathBuf = app
        .path()
        .audio_dir()
        .map_err(|error| format!("Could not locate the Music directory: {error}"))?
        .join("Ambra");

    std::fs::create_dir_all(&music_directory)
        .map_err(|error| format!("Could not create {}: {error}", music_directory.display()))?;
    let cache = cache_directory(app)?;
    let index_path = library_index_path(app)?;
    let had_index = index_path.is_file();

    let covers = cache.join("covers");
    let mut reconciled = scan_library(
        &music_directory,
        &cache.join("seekable-flac"),
        &covers,
        read_library_index(&index_path),
        library_index::default_workers(),
    );

    let pending = {
        let _lock = INDEX_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (thumbnails_changed, pending) = attach_thumbnails(&mut reconciled.entries, &covers);
        if reconciled.stats.changed() || thumbnails_changed || !had_index {
            if let Err(error) = save_library_index(&index_path, &reconciled.entries) {
                eprintln!("{error}");
            }
        }
        pending
    };
    spawn_thumbnail_worker(app.clone(), pending);
    if env::var_os("AMBRA_PERF").is_some() {
        eprintln!(
            "[ambra:perf] scan files={} reused={} read={} failed={} removed={} elapsed_ms={}",
            reconciled.entries.len(),
            reconciled.stats.reused,
            reconciled.stats.read,
            reconciled.stats.failed,
            reconciled.stats.removed,
            started.elapsed().as_millis()
        );
    }

    Ok(reconciled
        .entries
        .into_iter()
        .map(|entry| entry.track)
        .collect())
}

static PROCESS_STARTED: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Milliseconds since the Rust entry point began, for startup tracing.
#[tauri::command]
fn startup_elapsed_ms() -> u64 {
    PROCESS_STARTED
        .get()
        .map(|started| started.elapsed().as_millis() as u64)
        .unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = PROCESS_STARTED.set(Instant::now());
    let app = tauri::Builder::default()
        .plugin(window_bounds::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let server_log = app
                .path()
                .app_log_dir()
                .ok()
                .map(|directory| directory.join("ambra-server.log"));
            app.manage(BundledBackend::start(server_log));
            #[cfg(target_os = "windows")]
            keyboard::setup(app)?;
            media_controls::setup(app)?;
            native_audio::setup(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_persistent_state,
            save_persistent_state,
            startup_elapsed_ms,
            load_streaming_cache,
            save_streaming_cache,
            load_service_playlist_cache,
            save_service_playlist_cache,
            load_cached_music,
            local_music_directory,
            scan_music,
            keyboard::native_function_modifier_pressed,
            native_audio::load_native_audio,
            native_audio::warm_native_audio,
            native_audio::queue_native_audio,
            native_audio::play_native_audio,
            native_audio::pause_native_audio,
            native_audio::seek_native_audio,
            native_audio::native_audio_status,
            native_audio::list_native_audio_devices,
            native_audio::select_native_audio_device,
            native_audio::native_audio_exclusive_mode,
            native_audio::set_native_audio_exclusive_mode,
            native_audio::native_audio_volume,
            native_audio::set_native_audio_volume,
            native_audio::native_audio_settings,
            native_audio::set_native_audio_settings,
            native_audio::native_dsp_status,
            native_audio::import_dsp_impulse,
            native_audio::lyric_offset::detect_lyric_offset,
            media_controls::set_native_media_metadata,
            media_controls::set_native_media_playback,
            media_controls::set_native_media_commands_enabled
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<BundledBackend>().stop();
        }
    });
}
