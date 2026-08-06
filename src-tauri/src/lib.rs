use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use lofty::{file::TaggedFileExt, picture::PictureType, probe::read_from_path, tag::Accessor};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;
use walkdir::WalkDir;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    audio: String,
    cover: Option<String>,
    name: String,
    album: String,
    artist: String,
    track_number: Option<u32>,
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
            Ok(track) => Some(track),
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

    Ok(tracks)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![scan_music])
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
