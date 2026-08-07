use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use lofty::{
    file::{AudioFile, TaggedFileExt},
    picture::PictureType,
    probe::read_from_path,
    tag::Accessor,
};
use oxideav_core::{ContainerRegistry, NullCodecResolver, ReadSeek};

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    hash::{Hash, Hasher},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::Manager;
use walkdir::WalkDir;

mod media_controls;
mod native_audio;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    audio: String,
    cover: Option<String>,
    name: String,
    album: String,
    artist: String,
    track_number: Option<u32>,
    duration_seconds: f64,
}

fn library_cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|directory| directory.join("library.json"))
        .map_err(|error| format!("Could not locate Ambra's cache directory: {error}"))
}

fn save_library_cache(app: &tauri::AppHandle, tracks: &[Track]) -> Result<(), String> {
    let cache_path = library_cache_path(app)?;
    let cache_directory = cache_path
        .parent()
        .ok_or_else(|| "Ambra's library cache has no parent directory".to_owned())?;
    fs::create_dir_all(cache_directory).map_err(|error| {
        format!(
            "Could not create library cache {}: {error}",
            cache_directory.display()
        )
    })?;

    let temporary_path = cache_path.with_extension(format!("{}.tmp", std::process::id()));
    let encoded = serde_json::to_vec(tracks)
        .map_err(|error| format!("Could not encode the library cache: {error}"))?;
    fs::write(&temporary_path, encoded).map_err(|error| {
        format!(
            "Could not write library cache {}: {error}",
            temporary_path.display()
        )
    })?;
    fs::rename(&temporary_path, &cache_path).map_err(|error| {
        let _ = fs::remove_file(&temporary_path);
        format!(
            "Could not replace library cache {}: {error}",
            cache_path.display()
        )
    })
}

#[tauri::command]
async fn load_cached_music(app: tauri::AppHandle) -> Result<Vec<Track>, String> {
    let cache_path = library_cache_path(&app)?;
    let encoded = match fs::read(&cache_path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "Could not read library cache {}: {error}",
                cache_path.display()
            ));
        }
    };

    serde_json::from_slice(&encoded).map_err(|error| {
        format!(
            "Could not decode library cache {}: {error}",
            cache_path.display()
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

fn read_track(path: &Path, library_root: &Path) -> Result<Track, String> {
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
        .map(|picture| {
            let mime_type = picture
                .mime_type()
                .map(|mime_type| mime_type.as_str())
                .unwrap_or("image/jpeg");

            format!("data:{mime_type};base64,{}", BASE64.encode(picture.data()))
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
    })
}

#[tauri::command]
async fn scan_music(app: tauri::AppHandle) -> Result<Vec<Track>, String> {
    let music_directory: PathBuf = app
        .path()
        .audio_dir()
        .map_err(|error| format!("Could not locate the Music directory: {error}"))?
        .join("Ambra");

    std::fs::create_dir_all(&music_directory)
        .map_err(|error| format!("Could not create {}: {error}", music_directory.display()))?;
    let flac_cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate Ambra's cache directory: {error}"))?
        .join("seekable-flac");

    let mut tracks: Vec<Track> = WalkDir::new(&music_directory)
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
        .filter_map(|entry| match read_track(entry.path(), &music_directory) {
            Ok(mut track) => {
                if entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("flac"))
                {
                    match seekable_flac(entry.path(), &flac_cache) {
                        Ok(audio_path) => {
                            track.audio = audio_path.to_string_lossy().into_owned();
                        }
                        Err(error) => eprintln!("{error}"),
                    }
                }
                Some(track)
            }
            Err(error) => {
                eprintln!("{error}");
                None
            }
        })
        .collect();

    tracks.sort_by(|left, right| {
        left.artist
            .to_lowercase()
            .cmp(&right.artist.to_lowercase())
            .then_with(|| left.album.to_lowercase().cmp(&right.album.to_lowercase()))
            .then_with(|| left.track_number.cmp(&right.track_number))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    if let Err(error) = save_library_cache(&app, &tracks) {
        eprintln!("{error}");
    }

    Ok(tracks)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            media_controls::setup(app)?;
            native_audio::setup(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_cached_music,
            scan_music,
            native_audio::load_native_audio,
            native_audio::queue_native_audio,
            native_audio::play_native_audio,
            native_audio::pause_native_audio,
            native_audio::seek_native_audio,
            native_audio::native_audio_status,
            media_controls::set_native_media_metadata,
            media_controls::set_native_media_playback,
            media_controls::set_native_media_commands_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::folder_metadata;
    use std::path::Path;

    #[test]
    fn derives_artist_and_album_from_library_folders() {
        let library = Path::new("/Music/Ambra");
        let song = library.join("The Smiths/The Queen Is Dead/Bigmouth Strikes Again.mp3");

        let (artist, album) = folder_metadata(&song, library);

        assert_eq!(artist.as_deref(), Some("The Smiths"));
        assert_eq!(album.as_deref(), Some("The Queen Is Dead"));
    }
}
