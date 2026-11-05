//! Imports music files from this phone into the server's permanent library, as desktop's
//! importer does (`desktop/src-tauri/src/local_import.rs`): each file and its embedded cover
//! are uploaded under their content hash, then the song's details are registered.

use std::{io::Read, path::Path};

use ambra_net::ConnectionManager;
use axum::body::Body;
use http_body_util::BodyExt;
use lofty::{
    file::{AudioFile, TaggedFileExt},
    picture::PictureType,
    probe::read_from_path,
    tag::Accessor,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

type Result<T> = std::result::Result<T, String>;

/// The song's details as the server's local library stores them.
pub struct Details {
    pub name: String,
    pub artist: String,
    pub album: String,
    pub track_number: Option<u32>,
    pub duration_seconds: f64,
    pub cover: Option<(String, Vec<u8>)>,
}

pub fn read_details(path: &Path, fallback_name: &str) -> Result<Details> {
    let tagged = read_from_path(path).map_err(|error| format!("Could not read {fallback_name}: {error}"))?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let text = |value: Option<std::borrow::Cow<'_, str>>| value.map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
    let cover = tag
        .and_then(|tag| tag.pictures().iter().find(|picture| picture.pic_type() == PictureType::CoverFront).or_else(|| tag.pictures().first()))
        .map(|picture| {
            let mime = picture.mime_type().map(|mime| mime.as_str().to_owned()).unwrap_or_else(|| "image/jpeg".into());
            let extension = if mime.contains("png") { "png" } else if mime.contains("webp") { "webp" } else { "jpg" };
            (extension.to_owned(), picture.data().to_vec())
        });
    Ok(Details {
        name: text(tag.and_then(|tag| tag.title())).unwrap_or_else(|| fallback_name.to_owned()),
        artist: text(tag.and_then(|tag| tag.artist())).unwrap_or_else(|| "Unknown Artist".into()),
        album: text(tag.and_then(|tag| tag.album())).unwrap_or_else(|| "Unknown Album".into()),
        track_number: tag.and_then(|tag| tag.track()),
        duration_seconds: tagged.properties().duration().as_secs_f64(),
        cover,
    })
}

/// `{sha256}.{extension}`, the server's file ID.
pub fn file_id(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("bin").to_ascii_lowercase();
    let extension = if !extension.is_empty() && extension.len() <= 8 && extension.bytes().all(|byte| byte.is_ascii_alphanumeric()) { extension } else { "bin".into() };
    Ok(format!("{:x}.{extension}", hash.finalize()))
}

async fn send(manager: &ConnectionManager, method: hyper::Method, path: &str, body: Body, json_body: bool) -> Result<(hyper::StatusCode, bytes::Bytes)> {
    let mut request = hyper::Request::builder().method(method).uri(path);
    if json_body {
        request = request.header(hyper::header::CONTENT_TYPE, "application/json");
    }
    let request = request.body(body).map_err(|error| error.to_string())?;
    let response = manager.request(request).await.map_err(|error| error.to_string())?;
    let status = response.status();
    let bytes = response.into_body().collect().await.map(|body| body.to_bytes()).map_err(|error| error.to_string())?;
    Ok((status, bytes))
}

fn failure(status: hyper::StatusCode, body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body).ok().and_then(|value| value["error"].as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("Could not import music ({status})"))
}

/// Uploads unless the server already has it.
async fn upload(manager: &ConnectionManager, id: &str, body: impl FnOnce() -> Body) -> Result<()> {
    let path = format!("/api/music/local/files/{id}");
    let (status, _) = send(manager, hyper::Method::HEAD, &path, Body::empty(), false).await?;
    if status.is_success() {
        return Ok(());
    }
    let (status, response) = send(manager, hyper::Method::POST, &path, body(), false).await?;
    if status.is_success() { Ok(()) } else { Err(failure(status, &response)) }
}

/// Imports the file at `path` (named `name` on the phone) and returns the song as the server lists it.
pub async fn import(manager: &ConnectionManager, path: &Path, name: &str) -> Result<Value> {
    let fallback = Path::new(name).file_stem().and_then(|stem| stem.to_str()).unwrap_or("Unknown Track").to_owned();
    let owned = path.to_owned();
    let (details, id) = tokio::task::spawn_blocking(move || Ok::<_, String>((read_details(&owned, &fallback)?, file_id(&owned)?)))
        .await
        .map_err(|error| error.to_string())??;
    let file = tokio::fs::File::open(path).await.map_err(|error| error.to_string())?;
    upload(manager, &id, || Body::from_stream(tokio_util::io::ReaderStream::new(file))).await?;
    let artwork = match details.cover {
        Some((extension, bytes)) => {
            let cover = format!("{:x}.{extension}", Sha256::digest(&bytes));
            upload(manager, &cover, || Body::from(bytes)).await?;
            Some(cover)
        }
        None => None,
    };
    let artists = json!([{ "providerId": details.artist, "name": details.artist, "imageUrl": null }]);
    let metadata = json!({
        "file": id, "artwork": artwork, "legacyId": null,
        "name": details.name, "artist": details.artist, "album": details.album,
        "trackNumber": details.track_number, "durationSeconds": details.duration_seconds,
        "artists": artists, "albumArtists": artists,
        "version": null, "albumVersion": null, "albumId": null, "discNumber": null,
        "releaseDate": null, "explicit": false, "isrc": null, "copyright": null,
        "label": null, "genres": [], "upc": null, "quality": null,
        "maximumSamplingRateKHz": null, "maximumBitDepth": null,
    });
    let (status, response) = send(manager, hyper::Method::POST, "/api/music/local/tracks", Body::from(metadata.to_string()), true).await?;
    if !status.is_success() {
        return Err(failure(status, &response));
    }
    serde_json::from_slice(&response).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_named_by_their_content() {
        let path = std::env::temp_dir().join(format!("ambra-import-{}.FLAC", std::process::id()));
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(file_id(&path).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.flac");
        let _ = std::fs::remove_file(path);
    }
}
