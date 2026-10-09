use std::{
    collections::HashMap,
    env, fs,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime},
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
use librespot_oauth::{OAuthClient, OAuthClientBuilder, OAuthToken};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc};

use crate::models::{
    AlbumMetadata, ArtistMetadata, MusicProvider, PlaybackKind, PlaybackMetadata, TrackMetadata,
};

const SPOTIFY_OGG_HEADER_END: u64 = 0xa7;
const DEFAULT_OAUTH_PORT: u16 = 8898;
const AUDIO_CACHE_LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const OAUTH_REFRESH_MARGIN: Duration = Duration::from_secs(60);
const SESSION_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const SEARCH_ENDPOINT: &str = "https://api-partner.spotify.com/pathfinder/v2/query";
const SEARCH_OPERATION: &str = "findTracks";
const SEARCH_QUERY_HASH: &str = "903df2a65d8121e27d73a2be03c01e88ebe6021bb6d4eb82a389e35d87e51d27";
const SEARCH_PAGE_SIZE: usize = 5;

pub type ProviderResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub type AudioByteStream = mpsc::Receiver<Result<Bytes, io::Error>>;

#[derive(Clone)]
pub struct SpotifyProvider {
    session: Session,
    http_client: reqwest::Client,
    search_auth: Arc<Mutex<SpotifySearchAuth>>,
    oauth_refresh_path: Arc<PathBuf>,
    oauth_client_id: Arc<String>,
    quality: SpotifyQuality,
    tracks: Arc<Mutex<HashMap<String, Track>>>,
    track_metadata_cache: Arc<Mutex<HashMap<String, TrackMetadata>>>,
    track_metadata_cache_path: Arc<PathBuf>,
}

enum SpotifySearchAuth {
    Static(String),
    Refreshable(OAuthToken),
}

#[derive(Deserialize, Serialize)]
struct SavedSpotifyOAuth {
    refresh_token: String,
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
        let credentials_path = spotify_credentials_path();
        let audio_cache_path = spotify_audio_cache_path();
        let oauth_refresh_path = spotify_oauth_refresh_path();
        let cache = Cache::new(
            Some(&credentials_path),
            None::<&PathBuf>,
            Some(&audio_cache_path),
            Some(AUDIO_CACHE_LIMIT_BYTES),
        )?;
        make_cache_private(&credentials_path)?;

        let environment_access_token = nonempty_env("AMBRA_SPOTIFY_ACCESS_TOKEN");
        // Spotify prefers port 4070, which many networks block even when browser
        // sign-in succeeds over HTTPS. Use the resolver's supported port filter.
        let session_config = SessionConfig {
            ap_port: Some(443),
            ..SessionConfig::default()
        };
        let (credentials, search_auth) = if let Some(token) = environment_access_token {
            (
                Credentials::with_access_token(token.clone()),
                SpotifySearchAuth::Static(token),
            )
        } else if let Some(refresh_token) = load_spotify_refresh_token(&oauth_refresh_path) {
            let mut token = spotify_oauth_client(&session_config.client_id, false)?
                .refresh_token_async(&refresh_token)
                .await?;
            if token.refresh_token.is_empty() {
                token.refresh_token = refresh_token;
            }
            save_spotify_refresh_token(&oauth_refresh_path, &token.refresh_token)?;
            (
                Credentials::with_access_token(token.access_token.clone()),
                SpotifySearchAuth::Refreshable(token),
            )
        } else if interactive {
            let token = interactive_oauth_token(&session_config).await?;
            save_spotify_refresh_token(&oauth_refresh_path, &token.refresh_token)?;
            (
                Credentials::with_access_token(token.access_token.clone()),
                SpotifySearchAuth::Refreshable(token),
            )
        } else {
            return Ok(None);
        };

        let oauth_client_id = session_config.client_id.clone();
        let session = Session::new(session_config, Some(cache));
        tokio::time::timeout(SESSION_CONNECT_TIMEOUT, session.connect(credentials, true))
            .await
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Spotify session connection timed out. Check network access to Spotify on port 443.",
                )
            })??;
        session
            .login5()
            .set_auth_token(librespot_token_for_search(&search_auth));

        let track_metadata_cache_path = track_metadata_cache_path();
        let track_metadata_cache = load_track_metadata_cache(&track_metadata_cache_path);
        println!("Spotify logged in as {}", session.username());

        Ok(Some(Self {
            session,
            http_client: crate::http_client::builder().build()?,
            search_auth: Arc::new(Mutex::new(search_auth)),
            oauth_refresh_path: Arc::new(oauth_refresh_path),
            oauth_client_id: Arc::new(oauth_client_id),
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

    pub async fn artist_details(
        &self,
        artist_id: &str,
    ) -> ProviderResult<crate::models::CatalogArtist> {
        let artist = Artist::get(&self.session, &spotify_uri("artist", artist_id)?).await?;
        Ok(crate::models::CatalogArtist {
            id: format!("spotify:{}", artist.id.to_id()?),
            provider: MusicProvider::Spotify,
            name: artist.name.clone(),
            image_url: best_image_url(&artist.portraits),
        })
    }

    pub async fn artist_profile(
        &self,
        artist_id: &str,
    ) -> ProviderResult<crate::models::ArtistProfileMetadata> {
        use crate::models::{ArtistProfileMetadata, CatalogArtist};
        let artist = Artist::get(&self.session, &spotify_uri("artist", artist_id)?).await?;
        Ok(ArtistProfileMetadata {
            artist: CatalogArtist {
                id: format!("spotify:{}", artist.id.to_id()?),
                provider: MusicProvider::Spotify,
                name: artist.name.clone(),
                image_url: best_image_url(&artist.portraits),
            },
            biography: artist.biographies.first().map(|bio| bio.text.clone()),
            biography_source: None,
            popular_track_ids: artist
                .top_tracks
                .for_country(&self.session.country())
                .iter()
                .take(10)
                .map(|track| track.to_id())
                .collect::<Result<Vec<_>, _>>()?,
            popular_tracks_error: None,
        })
    }

    pub async fn artist_albums(
        &self,
        artist_id: &str,
        offset: u32,
        limit: u32,
    ) -> ProviderResult<crate::models::CatalogAlbumsPage> {
        use crate::models::{CatalogAlbum, CatalogAlbumsPage, search_next_offset};
        let artist = Artist::get(&self.session, &spotify_uri("artist", artist_id)?).await?;
        let ids: Vec<_> = artist
            .albums_current()
            .chain(artist.singles_current())
            .chain(artist.compilations_current())
            .cloned()
            .collect();
        let total = ids.len() as u32;
        let selected: Vec<_> = ids
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect();
        let next_offset = search_next_offset(offset, selected.len(), total);
        let mut albums = Vec::new();
        for id in selected {
            let album = Album::get(&self.session, &id).await?;
            albums.push(CatalogAlbum {
                id: format!("spotify:{}", album.id.to_id()?),
                provider: MusicProvider::Spotify,
                title: album.name.clone(),
                artist: album
                    .artists
                    .iter()
                    .map(|artist| artist.name.clone())
                    .collect::<Vec<_>>()
                    .join(", "),
                image_url: best_image_url(&album.covers),
                upc: external_id(&album.external_ids, &["upc", "ean"]),
                release_date: Some(format_spotify_date(&album.date)),
                release_type: Some(format!("{:?}", album.album_type).to_lowercase()),
                version: nonempty(&album.version_title),
                explicit: None,
                maximum_bit_depth: None,
                maximum_sampling_rate_khz: None,
            });
        }
        Ok(CatalogAlbumsPage {
            albums,
            next_offset,
        })
    }

    pub async fn search_track_ids(
        &self,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> ProviderResult<Vec<String>> {
        if limit == 0 || query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let access_token = self.search_access_token().await?;
        let client_token = self.session.spclient().client_token().await?;
        let mut track_ids = Vec::new();
        let mut page_offset = offset;
        let mut pages = 0;
        let mut total_count = None;

        while track_ids.len() < limit && pages < 5 {
            pages += 1;
            let page_limit = (limit - track_ids.len()).min(SEARCH_PAGE_SIZE);
            let response = self
                .http_client
                .post(SEARCH_ENDPOINT)
                .bearer_auth(&access_token)
                .header("client-token", &client_token)
                .header("app-platform", "WebPlayer")
                .json(&serde_json::json!({
                    "operationName": SEARCH_OPERATION,
                    "variables": {
                        "query": query.trim(),
                        "limit": page_limit,
                        "offset": page_offset,
                    },
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": SEARCH_QUERY_HASH,
                        }
                    }
                }))
                .send()
                .await?
                .error_for_status()?
                .json::<serde_json::Value>()
                .await?;

            if let Some(message) = response
                .get("errors")
                .and_then(serde_json::Value::as_array)
                .and_then(|errors| errors.first())
                .and_then(|error| error.get("message"))
                .and_then(serde_json::Value::as_str)
            {
                return Err(io::Error::other(format!("Spotify search failed: {message}")).into());
            }

            let page = spotify_track_ids_from_search(&response);
            let page_count = page.len();
            for track_id in page {
                if !track_ids.iter().any(|existing| existing == &track_id) {
                    track_ids.push(track_id);
                }
            }
            page_offset = page_offset.saturating_add(page_count);
            total_count = response
                .pointer("/data/searchV2/tracksV2/totalCount")
                .and_then(serde_json::Value::as_u64)
                .and_then(|count| usize::try_from(count).ok());
            if page_count < page_limit || total_count.is_some_and(|total| page_offset >= total) {
                break;
            }
        }

        if total_count.is_some_and(|total| offset.saturating_add(track_ids.len()) < total)
            && let Some(sentinel) = track_ids.last().cloned()
        {
            track_ids.resize(limit, sentinel);
        }

        Ok(track_ids.into_iter().take(limit).collect())
    }

    async fn search_access_token(&self) -> ProviderResult<String> {
        let refresh_token = {
            let auth = self.search_auth.lock().await;
            match &*auth {
                SpotifySearchAuth::Static(access_token) => return Ok(access_token.clone()),
                SpotifySearchAuth::Refreshable(token)
                    if token.expires_at > Instant::now() + OAUTH_REFRESH_MARGIN =>
                {
                    return Ok(token.access_token.clone());
                }
                SpotifySearchAuth::Refreshable(token) => token.refresh_token.clone(),
            }
        };

        let mut refreshed = spotify_oauth_client(&self.oauth_client_id, false)?
            .refresh_token_async(&refresh_token)
            .await?;
        if refreshed.refresh_token.is_empty() {
            refreshed.refresh_token = refresh_token;
        }
        save_spotify_refresh_token(&self.oauth_refresh_path, &refreshed.refresh_token)?;
        let access_token = refreshed.access_token.clone();
        self.session
            .login5()
            .set_auth_token(librespot_token_for_search(&SpotifySearchAuth::Refreshable(
                refreshed.clone(),
            )));
        *self.search_auth.lock().await = SpotifySearchAuth::Refreshable(refreshed);
        Ok(access_token)
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

        self.track_metadata_cache
            .lock()
            .await
            .insert(track_id.to_owned(), metadata.clone());
        crate::write_behind::schedule(
            self.track_metadata_cache.clone(),
            self.track_metadata_cache_path.clone(),
            "Spotify metadata cache",
            save_track_metadata_cache,
        );
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

async fn interactive_oauth_token(config: &SessionConfig) -> ProviderResult<OAuthToken> {
    let client = spotify_oauth_client(&config.client_id, true)?;
    Ok(tokio::task::spawn_blocking(move || client.get_access_token()).await??)
}

fn spotify_oauth_client(client_id: &str, open_in_browser: bool) -> ProviderResult<OAuthClient> {
    let port = env::var("AMBRA_SPOTIFY_OAUTH_PORT")
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(DEFAULT_OAUTH_PORT);
    let mut builder = OAuthClientBuilder::new(
        client_id,
        &format!("http://127.0.0.1:{port}/login"),
        vec!["streaming", "user-read-private"],
    )
    .with_custom_message(
        "Spotify authorization received. Return to Ambra to check connection status.",
    );
    if open_in_browser {
        builder = builder.open_in_browser();
    }
    Ok(builder.build()?)
}

fn librespot_token_for_search(auth: &SpotifySearchAuth) -> librespot_core::token::Token {
    match auth {
        SpotifySearchAuth::Static(access_token) => librespot_core::token::Token {
            access_token: access_token.clone(),
            expires_in: Duration::from_secs(24 * 60 * 60),
            token_type: "Bearer".to_owned(),
            scopes: vec!["streaming".to_owned(), "user-read-private".to_owned()],
            timestamp: SystemTime::now(),
        },
        SpotifySearchAuth::Refreshable(token) => librespot_core::token::Token {
            access_token: token.access_token.clone(),
            expires_in: token.expires_at.saturating_duration_since(Instant::now()),
            token_type: token.token_type.clone(),
            scopes: token.scopes.clone(),
            timestamp: SystemTime::now(),
        },
    }
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

fn spotify_track_ids_from_search(search_result: &serde_json::Value) -> Vec<String> {
    fn collect(value: &serde_json::Value, track_ids: &mut Vec<String>) {
        match value {
            serde_json::Value::Array(values) => {
                for value in values {
                    collect(value, track_ids);
                }
            }
            serde_json::Value::Object(values) => {
                if let Some(track_id) = values
                    .get("uri")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|uri| uri.strip_prefix("spotify:track:"))
                    && validate_spotify_id("track", track_id).is_ok()
                    && !track_ids.iter().any(|existing| existing == track_id)
                {
                    track_ids.push(track_id.to_owned());
                }
                for value in values.values() {
                    collect(value, track_ids);
                }
            }
            _ => {}
        }
    }

    let mut track_ids = Vec::new();
    let tracks = search_result
        .pointer("/data/searchV2/tracksV2")
        .unwrap_or(search_result);
    collect(tracks, &mut track_ids);
    track_ids
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

fn spotify_credentials_path() -> PathBuf {
    crate::storage::config_path("spotify")
}

fn spotify_audio_cache_path() -> PathBuf {
    crate::storage::cache_path("spotify/audio")
}

fn spotify_oauth_refresh_path() -> PathBuf {
    crate::storage::config_path("spotify/oauth.json")
}

fn track_metadata_cache_path() -> PathBuf {
    crate::storage::cache_path("spotify-metadata-cache.json")
}

fn load_spotify_refresh_token(path: &Path) -> Option<String> {
    let encoded = fs::read(path).ok()?;
    let saved = serde_json::from_slice::<SavedSpotifyOAuth>(&encoded).ok()?;
    nonempty(&saved.refresh_token)
}

fn save_spotify_refresh_token(path: &Path, refresh_token: &str) -> ProviderResult<()> {
    if refresh_token.trim().is_empty() {
        return Err(io::Error::other("Spotify did not return an OAuth refresh token").into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary_path = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary_path)?;
    file.write_all(&serde_json::to_vec(&SavedSpotifyOAuth {
        refresh_token: refresh_token.to_owned(),
    })?)?;
    fs::rename(temporary_path, path)?;
    Ok(())
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
    use super::{format_quality, spotify_track_ids_from_search, validate_spotify_id};
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

    #[test]
    fn extracts_unique_track_ids_from_search_results() {
        let result = serde_json::json!({
            "data": { "searchV2": { "tracksV2": { "items": [
                { "item": { "data": { "uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC" } } },
                { "item": { "data": { "uri": "spotify:track:4uLU6hMCjMI75M1A2tKUQC" } } },
                { "item": { "data": { "uri": "spotify:track:0VjIjW4GlUZAMYd2vXMi3b" } } }
            ] } } }
        });

        assert_eq!(
            spotify_track_ids_from_search(&result),
            ["4uLU6hMCjMI75M1A2tKUQC", "0VjIjW4GlUZAMYd2vXMi3b"]
        );
    }
}
