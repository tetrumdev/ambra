use std::{
    collections::HashMap,
    env, fs,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use bytes::Bytes;
use futures_util::future::join_all;
use librespot_audio::{AudioDecrypt, AudioFile, StreamLoaderController};
use librespot_core::{
    SpotifyUri, authentication::Credentials, cache::Cache, config::SessionConfig, session::Session,
};
use librespot_metadata::{
    Album, Artist, Metadata, Track,
    audio::{AudioFileFormat, AudioFiles},
    image::Images,
};
use librespot_oauth::OAuthClientBuilder;
use tokio::sync::{Mutex, mpsc};

use crate::models::{
    AlbumMetadata, ArtistMetadata, MusicProvider, PlaybackKind, PlaybackMetadata, TrackMetadata,
};

const SPOTIFY_OGG_HEADER_END: u64 = 0xa7;
const DEFAULT_OAUTH_PORT: u16 = 8898;
const AUDIO_CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub type ProviderResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub type AudioByteStream = mpsc::Receiver<Result<Bytes, io::Error>>;

#[derive(Clone)]
pub struct SpotifyProvider {
    session: Session,
    quality: SpotifyQuality,
    tracks: Arc<Mutex<HashMap<String, Track>>>,
    track_metadata_cache: Arc<Mutex<HashMap<String, TrackMetadata>>>,
    track_metadata_cache_path: Arc<PathBuf>,
}

pub struct PreparedSpotifyStream {
    reader: AudioDecrypt<AudioFile>,
    controller: StreamLoaderController,
    content_length: u64,
    header_offset: u64,
    mime_type: &'static str,
}

#[derive(Clone, Copy)]
enum SpotifyQuality {
    Kbps96,
    Kbps160,
    Kbps320,
}

impl SpotifyQuality {
    fn preferred_formats(self) -> &'static [AudioFileFormat] {
        use AudioFileFormat::*;

        match self {
            Self::Kbps96 => &[
                OGG_VORBIS_96,
                MP3_96,
                OGG_VORBIS_160,
                MP3_160,
                MP3_256,
                OGG_VORBIS_320,
                MP3_320,
            ],
            Self::Kbps160 => &[
                OGG_VORBIS_160,
                MP3_160,
                OGG_VORBIS_96,
                MP3_96,
                MP3_256,
                OGG_VORBIS_320,
                MP3_320,
            ],
            Self::Kbps320 => &[
                OGG_VORBIS_320,
                MP3_320,
                MP3_256,
                OGG_VORBIS_160,
                MP3_160,
                OGG_VORBIS_96,
                MP3_96,
            ],
        }
    }
}

impl SpotifyProvider {
    /// Spotify stays optional so an absent login never prevents other providers from starting.
    pub async fn authenticate_if_configured(interactive: bool) -> ProviderResult<Option<Self>> {
        let cache_root = spotify_cache_path();
        let audio_cache_path = cache_root.join("audio");
        let cache = Cache::new(
            Some(&cache_root),
            None::<&PathBuf>,
            Some(&audio_cache_path),
            Some(AUDIO_CACHE_LIMIT_BYTES),
        )?;
        make_cache_private(&cache_root)?;

        let environment_access_token = nonempty_env("AMBRA_SPOTIFY_ACCESS_TOKEN");
        let environment_username = nonempty_env("AMBRA_SPOTIFY_USERNAME");
        let environment_password = nonempty_env("AMBRA_SPOTIFY_PASSWORD");
        let interactive = interactive || env_flag("AMBRA_SPOTIFY_INTERACTIVE_LOGIN");
        let cached_credentials = cache.credentials();

        if environment_access_token.is_none()
            && (environment_username.is_none() || environment_password.is_none())
            && cached_credentials.is_none()
            && !interactive
        {
            return Ok(None);
        }

        let session_config = SessionConfig::default();
        let credentials = if let Some(token) = environment_access_token {
            Credentials::with_access_token(token)
        } else if let (Some(username), Some(password)) =
            (environment_username, environment_password)
        {
            Credentials::with_password(username, password)
        } else if interactive {
            interactive_credentials(&session_config).await?
        } else if let Some(credentials) = cached_credentials {
            credentials
        } else {
            return Ok(None);
        };

        let session = Session::new(session_config, Some(cache));
        session.connect(credentials, true).await?;

        let track_metadata_cache_path = track_metadata_cache_path();
        let track_metadata_cache = load_track_metadata_cache(&track_metadata_cache_path);
        println!("Spotify logged in as {}", session.username());

        Ok(Some(Self {
            session,
            quality: configured_quality(),
            tracks: Arc::new(Mutex::new(HashMap::new())),
            track_metadata_cache: Arc::new(Mutex::new(track_metadata_cache)),
            track_metadata_cache_path: Arc::new(track_metadata_cache_path),
        }))
    }

    pub async fn album_track_ids(&self, album_id: &str) -> ProviderResult<Vec<String>> {
        let album_uri = spotify_uri("album", album_id)?;
        let album = Album::get(&self.session, &album_uri).await?;
        album
            .tracks()
            .map(|track| Ok(track.to_id()?))
            .collect::<ProviderResult<Vec<_>>>()
    }

    pub async fn search_track_ids(
        &self,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> ProviderResult<Vec<String>> {
        let search_query = query
            .split_whitespace()
            .map(urlencoding::encode)
            .collect::<Vec<_>>()
            .join("+");
        let context = self
            .session
            .spclient()
            .get_context(&format!("spotify:search:{search_query}"))
            .await?;
        let mut track_ids = Vec::new();

        for uri in context
            .pages
            .into_iter()
            .flat_map(|page| page.tracks)
            .filter_map(|track| track.uri)
        {
            let Some(track_id) = uri.strip_prefix("spotify:track:") else {
                continue;
            };
            if validate_spotify_id("track", track_id).is_ok()
                && !track_ids.iter().any(|existing| existing == track_id)
            {
                track_ids.push(track_id.to_owned());
            }
        }

        Ok(track_ids.into_iter().skip(offset).take(limit).collect())
    }

    pub async fn track_metadata(&self, track_id: &str) -> ProviderResult<TrackMetadata> {
        validate_spotify_id("track", track_id)?;

        {
            let cache = self.track_metadata_cache.lock().await;
            if let Some(cached) = cache.get(track_id) {
                return Ok(cached.clone());
            }
        }

        let track = self.track(track_id).await?;
        let playable_track = self.playable_track(&track).await?;
        let (format, _) = self
            .selected_audio_file(&playable_track)
            .ok_or_else(|| io::Error::other("Spotify track has no supported audio file"))?;
        let full_album = Album::get(&self.session, &track.album.id)
            .await
            .unwrap_or_else(|_| track.album.clone());
        let artists = self.artist_metadata(&track.artists).await;
        let album_artists = self.artist_metadata(&full_album.artists).await;
        let primary_artist = artists
            .first()
            .cloned()
            .or_else(|| album_artists.first().cloned())
            .unwrap_or_else(unknown_artist);

        let metadata = TrackMetadata {
            id: format!("spotify:{track_id}"),
            provider: MusicProvider::Spotify,
            provider_track_id: track_id.to_owned(),
            title: track.name.clone(),
            version: nonempty(&track.version_title),
            primary_artist: primary_artist.clone(),
            artists: if artists.is_empty() {
                vec![primary_artist.clone()]
            } else {
                artists
            },
            album: Some(AlbumMetadata {
                provider_id: full_album.id.to_id()?,
                title: full_album.name.clone(),
                version: nonempty(&full_album.version_title),
                artists: if album_artists.is_empty() {
                    vec![primary_artist]
                } else {
                    album_artists
                },
                cover_url: best_image_url(&full_album.covers),
                release_date: Some(format_spotify_date(&full_album.date)),
                label: nonempty(&full_album.label),
                genres: unique_nonempty(track.tags.clone()),
                upc: external_id(&full_album.external_ids, &["upc", "ean"]),
            }),
            duration_seconds: u64::try_from(track.duration.max(0)).unwrap_or(0) / 1_000,
            track_number: positive_u32(track.number),
            disc_number: positive_u32(track.disc_number),
            explicit: track.is_explicit,
            isrc: external_id(&track.external_ids, &["isrc"]),
            copyright: album_copyright(&full_album),
            quality: Some(format_quality(format).to_owned()),
            maximum_sampling_rate_khz: Some(44.1),
            maximum_bit_depth: None,
            playback: PlaybackMetadata {
                kind: PlaybackKind::Direct,
                url: format!("/api/providers/spotify/tracks/{track_id}/stream"),
            },
        };

        let mut cache = self.track_metadata_cache.lock().await;
        cache.insert(track_id.to_owned(), metadata.clone());
        if let Err(error) = save_track_metadata_cache(&self.track_metadata_cache_path, &cache) {
            eprintln!("Could not persist Spotify metadata cache: {error}");
        }
        Ok(metadata)
    }

    pub async fn prepare_stream(&self, track_id: &str) -> ProviderResult<PreparedSpotifyStream> {
        let track = self.track(track_id).await?;
        let playable_track = self.playable_track(&track).await?;
        let (format, file_id) = self
            .selected_audio_file(&playable_track)
            .ok_or_else(|| io::Error::other("Spotify track has no supported audio file"))?;
        let encrypted_file =
            AudioFile::open(&self.session, file_id, stream_bytes_per_second(format)).await?;
        let controller = encrypted_file.get_stream_loader_controller()?;
        let SpotifyUri::Track {
            id: playable_track_id,
        } = playable_track.id
        else {
            return Err(io::Error::other("Spotify metadata did not contain a track ID").into());
        };
        let key = self
            .session
            .audio_key()
            .request(playable_track_id, file_id)
            .await
            .ok();
        let header_offset = if AudioFiles::is_ogg_vorbis(format) {
            SPOTIFY_OGG_HEADER_END
        } else {
            0
        };
        let content_length = u64::try_from(controller.len())?
            .checked_sub(header_offset)
            .ok_or_else(|| io::Error::other("Spotify audio file is shorter than its header"))?;
        if content_length == 0 {
            return Err(io::Error::other("Spotify returned an empty audio file").into());
        }

        Ok(PreparedSpotifyStream {
            reader: AudioDecrypt::new(key, encrypted_file),
            controller,
            content_length,
            header_offset,
            mime_type: AudioFiles::mime_type(format).unwrap_or("application/octet-stream"),
        })
    }

    async fn track(&self, track_id: &str) -> ProviderResult<Track> {
        validate_spotify_id("track", track_id)?;
        if let Some(track) = self.tracks.lock().await.get(track_id).cloned() {
            return Ok(track);
        }

        let uri = spotify_uri("track", track_id)?;
        let track = Track::get(&self.session, &uri).await?;
        self.tracks
            .lock()
            .await
            .insert(track_id.to_owned(), track.clone());
        Ok(track)
    }

    async fn playable_track(&self, track: &Track) -> ProviderResult<Track> {
        if self.selected_audio_file(track).is_some() {
            return Ok(track.clone());
        }

        for alternative_uri in track.alternatives.iter() {
            if let Ok(alternative) = Track::get(&self.session, alternative_uri).await
                && self.selected_audio_file(&alternative).is_some()
            {
                return Ok(alternative);
            }
        }

        Err(io::Error::other("Spotify track is unavailable in this account's market").into())
    }

    fn selected_audio_file(
        &self,
        track: &Track,
    ) -> Option<(AudioFileFormat, librespot_core::FileId)> {
        self.quality
            .preferred_formats()
            .iter()
            .find_map(|format| track.files.get(format).map(|file_id| (*format, *file_id)))
    }

    async fn artist_metadata(
        &self,
        artists: &librespot_metadata::artist::Artists,
    ) -> Vec<ArtistMetadata> {
        join_all(artists.iter().cloned().map(|summary| {
            let session = self.session.clone();
            async move {
                let artist = Artist::get(&session, &summary.id).await.unwrap_or(summary);
                ArtistMetadata {
                    provider_id: artist.id.to_id().unwrap_or_default(),
                    name: artist.name,
                    image_url: best_image_url(&artist.portraits),
                }
            }
        }))
        .await
    }
}

impl PreparedSpotifyStream {
    pub fn content_length(&self) -> u64 {
        self.content_length
    }

    pub fn mime_type(&self) -> &'static str {
        self.mime_type
    }

    pub fn into_byte_stream(mut self, start: u64, end_inclusive: u64) -> AudioByteStream {
        let (sender, receiver) = mpsc::channel(8);
        if start == 0 {
            self.controller.set_stream_mode();
        } else {
            self.controller.set_random_access_mode();
        }

        tokio::task::spawn_blocking(move || {
            let result = (|| -> io::Result<()> {
                self.reader
                    .seek(SeekFrom::Start(self.header_offset.saturating_add(start)))?;
                let length = end_inclusive.saturating_sub(start).saturating_add(1);
                let mut reader = self.reader.take(length);
                let mut buffer = vec![0_u8; 64 * 1024];

                loop {
                    let read = reader.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    if sender
                        .blocking_send(Ok(Bytes::copy_from_slice(&buffer[..read])))
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(())
            })();

            if let Err(error) = result {
                let _ = sender.blocking_send(Err(error));
            }
            self.controller.close();
        });
        receiver
    }
}

async fn interactive_credentials(config: &SessionConfig) -> ProviderResult<Credentials> {
    let port = env::var("AMBRA_SPOTIFY_OAUTH_PORT")
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(DEFAULT_OAUTH_PORT);
    let client = OAuthClientBuilder::new(
        &config.client_id,
        &format!("http://127.0.0.1:{port}/login"),
        vec!["streaming"],
    )
    .open_in_browser()
    .with_custom_message("Spotify connected. You can return to Ambra.")
    .build()?;
    let token = tokio::task::spawn_blocking(move || client.get_access_token()).await??;
    Ok(Credentials::with_access_token(token.access_token))
}

fn spotify_uri(kind: &str, id: &str) -> ProviderResult<SpotifyUri> {
    Ok(SpotifyUri::from_uri(&format!("spotify:{kind}:{id}"))?)
}

fn validate_spotify_id(kind: &str, id: &str) -> ProviderResult<()> {
    if id.len() != 22
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("'{id}' is not a valid Spotify {kind} ID"),
        )
        .into());
    }
    spotify_uri(kind, id)?;
    Ok(())
}

fn configured_quality() -> SpotifyQuality {
    match env::var("AMBRA_SPOTIFY_QUALITY")
        .unwrap_or_else(|_| "320".to_owned())
        .trim()
    {
        "96" => SpotifyQuality::Kbps96,
        "160" => SpotifyQuality::Kbps160,
        _ => SpotifyQuality::Kbps320,
    }
}

fn stream_bytes_per_second(format: AudioFileFormat) -> usize {
    use AudioFileFormat::*;

    match format {
        OGG_VORBIS_96 | MP3_96 => 12 * 1024,
        OGG_VORBIS_160 | MP3_160 | MP3_160_ENC => 20 * 1024,
        MP3_256 => 32 * 1024,
        OGG_VORBIS_320 | MP3_320 => 40 * 1024,
        _ => 40 * 1024,
    }
}

fn format_quality(format: AudioFileFormat) -> &'static str {
    use AudioFileFormat::*;

    match format {
        OGG_VORBIS_96 => "Ogg Vorbis 96 kbps",
        OGG_VORBIS_160 => "Ogg Vorbis 160 kbps",
        OGG_VORBIS_320 => "Ogg Vorbis 320 kbps",
        MP3_96 => "MP3 96 kbps",
        MP3_160 | MP3_160_ENC => "MP3 160 kbps",
        MP3_256 => "MP3 256 kbps",
        MP3_320 => "MP3 320 kbps",
        _ => "Spotify audio",
    }
}

fn best_image_url(images: &Images) -> Option<String> {
    images
        .iter()
        .max_by_key(|image| i64::from(image.width.max(0)) * i64::from(image.height.max(0)))
        .and_then(|image| image.id.to_base16().ok())
        .map(|image_id| format!("https://i.scdn.co/image/{image_id}"))
}

fn format_spotify_date(date: &librespot_core::date::Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        date.month() as u8,
        date.day()
    )
}

fn external_id(
    external_ids: &librespot_metadata::external_id::ExternalIds,
    names: &[&str],
) -> Option<String> {
    external_ids
        .iter()
        .find(|external_id| {
            names
                .iter()
                .any(|name| external_id.external_type.eq_ignore_ascii_case(name))
        })
        .and_then(|external_id| nonempty(&external_id.id))
}

fn album_copyright(album: &Album) -> Option<String> {
    nonempty(
        &album
            .copyrights
            .iter()
            .map(|copyright| copyright.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" · "),
    )
}

fn unique_nonempty(values: Vec<String>) -> Vec<String> {
    let mut unique = Vec::new();
    for value in values {
        let value = value.trim();
        if !value.is_empty()
            && !unique
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(value))
        {
            unique.push(value.to_owned());
        }
    }
    unique
}

fn positive_u32(value: i32) -> Option<u32> {
    u32::try_from(value).ok().filter(|value| *value > 0)
}

fn unknown_artist() -> ArtistMetadata {
    ArtistMetadata {
        provider_id: String::new(),
        name: "Unknown Artist".to_owned(),
        image_url: None,
    }
}

fn nonempty(value: &str) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.trim().to_owned())
}

fn nonempty_env(name: &str) -> Option<String> {
    env::var(name).ok().and_then(|value| nonempty(&value))
}

fn env_flag(name: &str) -> bool {
    env::var(name).is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn spotify_cache_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".spotify-cache")
}

fn track_metadata_cache_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".spotify-metadata-cache.json")
}

fn make_cache_private(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn load_track_metadata_cache(path: &Path) -> HashMap<String, TrackMetadata> {
    let encoded = match fs::read(path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return HashMap::new(),
        Err(error) => {
            eprintln!("Could not read Spotify metadata cache: {error}");
            return HashMap::new();
        }
    };
    serde_json::from_slice(&encoded).unwrap_or_else(|error| {
        eprintln!("Could not decode Spotify metadata cache: {error}");
        HashMap::new()
    })
}

fn save_track_metadata_cache(
    path: &Path,
    cache: &HashMap<String, TrackMetadata>,
) -> ProviderResult<()> {
    let temporary_path = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary_path)?;
    file.write_all(&serde_json::to_vec(cache)?)?;
    fs::rename(temporary_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{format_quality, validate_spotify_id};
    use librespot_metadata::audio::AudioFileFormat;

    #[test]
    fn validates_base62_spotify_ids() {
        assert!(validate_spotify_id("album", "4aawyAB9vmqN3uQ7FjRGTy").is_ok());
        assert!(validate_spotify_id("album", "not-an-id").is_err());
    }

    #[test]
    fn labels_spotify_delivery_quality() {
        assert_eq!(
            format_quality(AudioFileFormat::OGG_VORBIS_320),
            "Ogg Vorbis 320 kbps"
        );
    }
}
