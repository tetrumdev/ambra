use std::{
    collections::HashMap,
    fs,
    io::{self, Write},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use tidlers::{
    TidalClient,
    auth::TidalAuth,
    client::models::{
        playback::AudioQuality,
        search::config::{SearchConfig, SearchType},
        track::playback::{DashManifest, ParsedTrackManifest},
    },
    error::TidalError,
    requests::RequestClientError,
    resources::uuid_to_url_with_size,
};
use tokio::sync::Mutex;

use crate::models::{
    AlbumMetadata, ArtistMetadata, MusicProvider, PlaybackKind, PlaybackMetadata, TrackMetadata,
};

const PLAYBACK_SOURCE_TTL: Duration = Duration::from_secs(5 * 60);
pub type ProviderResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone)]
pub struct TidalProvider {
    client: Arc<Mutex<TidalClient>>,
    http_client: reqwest::Client,
    playback_sources: Arc<Mutex<HashMap<String, CachedPlaybackSource>>>,
    track_metadata_cache: Arc<Mutex<HashMap<String, TrackMetadata>>>,
    track_metadata_cache_path: Arc<PathBuf>,
}

#[derive(Clone, Debug)]
pub enum PlaybackSource {
    Direct {
        url: String,
        mime_type: String,
        quality: String,
    },
    Dash {
        initialization_url: String,
        media_url_template: String,
        mime_type: String,
        codecs: String,
        bandwidth: Option<u32>,
        timescale: u32,
        segment_duration: u32,
        start_number: u32,
        segment_count: Option<u32>,
        track_duration_seconds: u64,
        quality: String,
    },
}

struct CachedPlaybackSource {
    source: PlaybackSource,
    cached_at: Instant,
}

impl TidalProvider {
    pub async fn authenticate() -> ProviderResult<Self> {
        let mut client = authenticated_client().await?;
        client.set_audio_quality(AudioQuality::High);

        let track_metadata_cache_path = track_metadata_cache_path();
        let track_metadata_cache = load_track_metadata_cache(&track_metadata_cache_path);

        Ok(Self {
            client: Arc::new(Mutex::new(client)),
            http_client: reqwest::Client::new(),
            playback_sources: Arc::new(Mutex::new(HashMap::new())),
            track_metadata_cache: Arc::new(Mutex::new(track_metadata_cache)),
            track_metadata_cache_path: Arc::new(track_metadata_cache_path),
        })
    }

    pub async fn track_metadata(&self, track_id: &str) -> ProviderResult<TrackMetadata> {
        validate_track_id(track_id)?;

        {
            let cache = self.track_metadata_cache.lock().await;
            if let Some(cached) = cache.get(track_id) {
                return Ok(cached.clone());
            }
        }

        let (track, album_details) = {
            let client = self.client.lock().await.clone();
            let track = client.get_track(track_id).await?;
            let album_details = match track.album.as_ref() {
                Some(album) => client.get_album(album.id.to_string()).await.ok(),
                None => None,
            };
            (track, album_details)
        };

        if !track.allow_streaming || !track.stream_ready {
            return Err(io::Error::other("Tidal reports that this track is not streamable").into());
        }

        let primary_artist = ArtistMetadata {
            provider_id: track.artist.id.to_string(),
            name: track.artist.name.clone(),
            image_url: track
                .artist
                .picture
                .as_deref()
                .map(|picture| uuid_to_url_with_size(picture, 750)),
        };
        let artists = if track.artists.is_empty() {
            vec![primary_artist.clone()]
        } else {
            track
                .artists
                .iter()
                .map(|artist| ArtistMetadata {
                    provider_id: artist.id.to_string(),
                    name: artist.name.clone(),
                    image_url: artist
                        .picture
                        .as_deref()
                        .map(|picture| uuid_to_url_with_size(picture, 750)),
                })
                .collect()
        };
        let album = track.album.as_ref().map(|album| AlbumMetadata {
            provider_id: album.id.to_string(),
            title: album.title.clone(),
            version: album_details
                .as_ref()
                .and_then(|album| album.version.clone()),
            artists: album_details
                .as_ref()
                .map(|album| {
                    album
                        .artists
                        .iter()
                        .map(|artist| ArtistMetadata {
                            provider_id: artist.id.to_string(),
                            name: artist.name.clone(),
                            image_url: artist
                                .picture
                                .as_deref()
                                .map(|picture| uuid_to_url_with_size(picture, 750)),
                        })
                        .collect()
                })
                .filter(|artists: &Vec<_>| !artists.is_empty())
                .unwrap_or_else(|| vec![primary_artist.clone()]),
            cover_url: album
                .cover
                .as_deref()
                .map(|cover| uuid_to_url_with_size(cover, 1280)),
            release_date: album.release_date.clone().or_else(|| {
                album_details
                    .as_ref()
                    .map(|album| album.release_date.clone())
            }),
            label: None,
            genres: Vec::new(),
            upc: album_details
                .as_ref()
                .map(|album| album.upc.clone())
                .filter(|upc| !upc.is_empty()),
        });

        let (playback, quality) = match self.playback_source(track_id).await? {
            PlaybackSource::Direct { quality, .. } => (
                PlaybackMetadata {
                    kind: PlaybackKind::Direct,
                    url: format!("/api/providers/tidal/tracks/{track_id}/stream"),
                },
                quality,
            ),
            PlaybackSource::Dash { quality, .. } => (
                PlaybackMetadata {
                    kind: PlaybackKind::Dash,
                    url: format!("/api/providers/tidal/tracks/{track_id}/manifest.mpd"),
                },
                quality,
            ),
        };

        let metadata = TrackMetadata {
            id: format!("tidal:{track_id}"),
            provider: MusicProvider::Tidal,
            provider_track_id: track_id.to_owned(),
            title: track.title,
            version: track.version,
            primary_artist,
            artists,
            album,
            duration_seconds: track.duration,
            track_number: Some(track.track_number),
            disc_number: Some(track.volume_number),
            explicit: track.explicit,
            isrc: track.isrc,
            copyright: track.copyright,
            quality: Some(quality),
            maximum_sampling_rate_khz: None,
            maximum_bit_depth: None,
            playback,
        };
        let mut cache = self.track_metadata_cache.lock().await;
        cache.insert(track_id.to_owned(), metadata.clone());
        if let Err(error) = save_track_metadata_cache(&self.track_metadata_cache_path, &cache) {
            eprintln!("Could not persist Tidal metadata cache: {error}");
        }

        Ok(metadata)
    }

    pub async fn album_track_ids(&self, album_id: &str) -> ProviderResult<Vec<String>> {
        validate_album_id(album_id)?;

        let client = self.client.lock().await.clone();
        let mut track_ids = Vec::new();
        let mut offset = 0_u64;

        loop {
            let page = client
                .get_album_items(album_id.to_owned(), Some(100), Some(offset))
                .await?;
            let page_length = page.items.len();
            track_ids.extend(
                page.items
                    .into_iter()
                    .map(|entry| entry.item.id.to_string()),
            );

            if page_length == 0 || track_ids.len() >= page.total_number_of_items.max(0) as usize {
                break;
            }

            offset += page_length as u64;
        }

        Ok(track_ids)
    }

    pub async fn search_track_ids(&self, query: &str, limit: u32) -> ProviderResult<Vec<String>> {
        let client = self.client.lock().await.clone();
        let results = client
            .search(SearchConfig {
                query: query.to_owned(),
                types: vec![SearchType::Tracks],
                limit,
                ..Default::default()
            })
            .await?;

        Ok(results
            .tracks
            .into_iter()
            .flat_map(|section| section.items)
            .filter(|track| track.allow_streaming.unwrap_or(true))
            .filter(|track| track.stream_ready.unwrap_or(true))
            .map(|track| track.id.to_string())
            .collect())
    }

    pub async fn playback_source(&self, track_id: &str) -> ProviderResult<PlaybackSource> {
        validate_track_id(track_id)?;

        {
            let cache = self.playback_sources.lock().await;
            if let Some(cached) = cache.get(track_id)
                && cached.cached_at.elapsed() < PLAYBACK_SOURCE_TTL
            {
                return Ok(cached.source.clone());
            }
        }

        let client = {
            let mut client = self.client.lock().await;
            if client.refresh_access_token(false).await? {
                save_session(&client)?;
            }
            client.clone()
        };

        let mut track = client.get_track(track_id).await;
        let mut playback = client
            .get_track_postpaywall_playback_info(track_id, None)
            .await;
        if track.as_ref().is_err_and(is_unauthorized)
            || playback.as_ref().is_err_and(is_unauthorized)
        {
            let client = {
                let mut client = self.client.lock().await;
                client.refresh_access_token(true).await?;
                save_session(&client)?;
                client.clone()
            };
            track = client.get_track(track_id).await;
            playback = client
                .get_track_postpaywall_playback_info(track_id, None)
                .await;
        }
        let track = track?;
        let playback = playback?;
        let quality = playback.audio_quality.clone();

        let source = match playback.manifest_parsed {
            Some(ParsedTrackManifest::Json(manifest)) => {
                let url = manifest.urls.into_iter().next().ok_or_else(|| {
                    io::Error::other("Tidal playback manifest contains no stream URL")
                })?;

                PlaybackSource::Direct {
                    url: normalize_dash_url(&url),
                    mime_type: manifest.mime_type,
                    quality,
                }
            }
            Some(ParsedTrackManifest::Dash(manifest)) => {
                playback_source_from_dash(&self.http_client, manifest, track.duration, quality)
                    .await?
            }
            None => {
                return Err(io::Error::other("Tidlers did not parse the playback manifest").into());
            }
        };
        self.playback_sources.lock().await.insert(
            track_id.to_owned(),
            CachedPlaybackSource {
                source: source.clone(),
                cached_at: Instant::now(),
            },
        );

        Ok(source)
    }
}

fn is_unauthorized(error: &TidalError) -> bool {
    matches!(
        error,
        TidalError::RequestClient(RequestClientError::Unauthorized)
    )
}

async fn playback_source_from_dash(
    http_client: &reqwest::Client,
    manifest: DashManifest,
    track_duration_seconds: u64,
    quality: String,
) -> ProviderResult<PlaybackSource> {
    let initialization_url = manifest
        .get_init_url()
        .ok_or_else(|| io::Error::other("Tidal DASH manifest has no initialization segment"))?;
    let media_url_template = manifest
        .get_media_template()
        .ok_or_else(|| io::Error::other("Tidal DASH manifest has no media template"))?;
    let timescale = manifest.timescale.unwrap_or(1);
    let start_number = manifest.start_number.unwrap_or(1);
    let normalized_media_template = normalize_dash_url(media_url_template);
    let segment_duration = match manifest.duration {
        Some(duration) if duration > 0 => duration,
        _ => {
            infer_segment_duration(
                http_client,
                &normalized_media_template,
                start_number,
                timescale,
            )
            .await?
        }
    };

    Ok(PlaybackSource::Dash {
        initialization_url: normalize_dash_url(initialization_url),
        media_url_template: normalized_media_template,
        mime_type: manifest.mime_type.clone(),
        codecs: manifest.codecs.clone(),
        bandwidth: manifest.bitrate,
        timescale,
        segment_duration,
        start_number,
        segment_count: dash_segment_count(timescale, segment_duration, track_duration_seconds),
        track_duration_seconds,
        quality,
    })
}

async fn infer_segment_duration(
    client: &reqwest::Client,
    media_url_template: &str,
    start_number: u32,
    timescale: u32,
) -> ProviderResult<u32> {
    let next_number = start_number
        .checked_add(1)
        .ok_or_else(|| io::Error::other("DASH segment number overflowed"))?;
    let first_url = media_url_template.replace("$Number$", &start_number.to_string());
    let next_url = media_url_template.replace("$Number$", &next_number.to_string());
    let (first, next) = tokio::try_join!(
        download_dash_fragment(client, &first_url),
        download_dash_fragment(client, &next_url)
    )?;
    let first_time = base_media_decode_time(&first)
        .ok_or_else(|| io::Error::other("First DASH fragment has no tfdt timestamp"))?;
    let next_time = base_media_decode_time(&next)
        .ok_or_else(|| io::Error::other("Second DASH fragment has no tfdt timestamp"))?;
    let duration = next_time
        .checked_sub(first_time)
        .and_then(|duration| duration.try_into().ok())
        .filter(|duration: &u32| *duration > 0)
        .ok_or_else(|| io::Error::other("DASH fragment timestamps do not increase"))?;

    if timescale == 0 {
        return Err(io::Error::other("Tidal DASH manifest has a zero timescale").into());
    }

    Ok(duration)
}

async fn download_dash_fragment(client: &reqwest::Client, url: &str) -> ProviderResult<Vec<u8>> {
    let response = client.get(url).send().await?;
    if !response.status().is_success() {
        return Err(io::Error::other(format!(
            "Tidal returned HTTP {} while reading DASH timing",
            response.status()
        ))
        .into());
    }
    Ok(response.bytes().await?.to_vec())
}

fn base_media_decode_time(fragment: &[u8]) -> Option<u64> {
    let type_offset = fragment.windows(4).position(|bytes| bytes == b"tfdt")?;
    let version = *fragment.get(type_offset + 4)?;
    let value_offset = type_offset + 8;

    if version == 1 {
        Some(u64::from_be_bytes(
            fragment
                .get(value_offset..value_offset + 8)?
                .try_into()
                .ok()?,
        ))
    } else {
        Some(u64::from(u32::from_be_bytes(
            fragment
                .get(value_offset..value_offset + 4)?
                .try_into()
                .ok()?,
        )))
    }
}

fn dash_segment_count(
    timescale: u32,
    segment_duration: u32,
    track_duration_seconds: u64,
) -> Option<u32> {
    let timescale = u64::from(timescale);
    let segment_duration = u64::from(segment_duration);
    if timescale == 0 || segment_duration == 0 {
        return None;
    }

    let track_duration = track_duration_seconds.checked_mul(timescale)?;
    let count = track_duration
        .checked_add(segment_duration - 1)?
        .checked_div(segment_duration)?;
    count.try_into().ok()
}

fn normalize_dash_url(url: &str) -> String {
    url.replace("&amp;", "&")
}

async fn authenticated_client() -> ProviderResult<TidalClient> {
    if let Some(client) = restore_session().await? {
        println!("Using saved Tidal session");
        return Ok(client);
    }

    let auth = TidalAuth::with_pkce();
    let mut client = TidalClient::new(&auth);
    let login_url = client.initiate_pkce_login()?;

    println!("Visit this URL and sign in:\n{login_url}\n");
    print!("Paste the full callback URL: ");
    io::stdout().flush()?;

    let mut redirect_url = String::new();
    io::stdin().read_line(&mut redirect_url)?;
    client.finish_pkce_login(redirect_url.trim()).await?;
    client.refresh_user_info().await?;
    save_session(&client)?;

    let username = client
        .user_info
        .as_ref()
        .map(|user| user.username.as_str())
        .unwrap_or("unknown user");
    println!("Logged in as {username}");

    Ok(client)
}

async fn restore_session() -> ProviderResult<Option<TidalClient>> {
    let session_json = match fs::read_to_string(session_path()) {
        Ok(session_json) => session_json,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };

    let mut client = match TidalClient::from_json(&session_json) {
        Ok(client) => client,
        Err(error) => {
            eprintln!("Saved Tidal session is invalid ({error}); signing in again");
            return Ok(None);
        }
    };

    if let Err(error) = client.refresh_access_token(false).await {
        eprintln!("Saved Tidal session cannot be refreshed ({error}); signing in again");
        return Ok(None);
    }

    if let Err(error) = client.refresh_user_info().await {
        eprintln!("Saved Tidal session cannot load the user ({error}); signing in again");
        return Ok(None);
    }

    save_session(&client)?;
    Ok(Some(client))
}

fn save_session(client: &TidalClient) -> ProviderResult<()> {
    let path = session_path();
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(path)?;
    file.write_all(client.get_json().as_bytes())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

fn session_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".tidal-session.json")
}

fn track_metadata_cache_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".tidal-metadata-cache.json")
}

fn load_track_metadata_cache(path: &PathBuf) -> HashMap<String, TrackMetadata> {
    let encoded = match fs::read(path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return HashMap::new(),
        Err(error) => {
            eprintln!("Could not read Tidal metadata cache: {error}");
            return HashMap::new();
        }
    };

    serde_json::from_slice(&encoded).unwrap_or_else(|error| {
        eprintln!("Could not decode Tidal metadata cache: {error}");
        HashMap::new()
    })
}

fn save_track_metadata_cache(
    path: &PathBuf,
    cache: &HashMap<String, TrackMetadata>,
) -> ProviderResult<()> {
    let temporary_path = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary_path, serde_json::to_vec(cache)?)?;
    fs::rename(temporary_path, path)?;
    Ok(())
}

fn validate_track_id(track_id: &str) -> ProviderResult<()> {
    track_id.parse::<u64>().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("'{track_id}' is not a numeric Tidal track ID"),
        )
    })?;
    Ok(())
}

fn validate_album_id(album_id: &str) -> ProviderResult<()> {
    album_id.parse::<u64>().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("'{album_id}' is not a numeric Tidal album ID"),
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{base_media_decode_time, dash_segment_count, normalize_dash_url};

    #[test]
    fn decodes_xml_entities_in_signed_dash_urls() {
        let encoded = "https://audio.example/segment?token=abc&amp;expires=123";

        assert_eq!(
            normalize_dash_url(encoded),
            "https://audio.example/segment?token=abc&expires=123"
        );
    }

    #[test]
    fn calculates_dash_segment_count_from_track_duration() {
        assert_eq!(dash_segment_count(1_000, 4_000, 230), Some(58));
    }

    #[test]
    fn reads_version_one_fragment_timestamp() {
        let fragment = [
            0, 0, 0, 20, b't', b'f', b'd', b't', 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 176, 0,
        ];

        assert_eq!(base_media_decode_time(&fragment), Some(176_128));
    }
}
