use std::{
    collections::HashMap,
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use qbz_models::{Album, Artist, Quality, Track, UserSession};
use qbz_qobuz::QobuzClient;
use tokio::sync::Mutex;

use crate::artwork_quality::{qobuz_max_artwork_url, same_release_upc};
use crate::models::{
    AlbumMetadata, ArtistMetadata, MusicProvider, PlaybackKind, PlaybackMetadata, SearchPage,
    TrackMetadata, search_next_offset,
};

const PLAYBACK_SOURCE_TTL: Duration = Duration::from_secs(30 * 60);
const OAUTH_REDIRECT_URL: &str = "http://127.0.0.1:8788/qobuz";

pub type ProviderResult<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone)]
pub struct QobuzProvider {
    client: Arc<QobuzClient>,
    preferred_quality: Quality,
    playback_sources: Arc<Mutex<HashMap<String, CachedPlaybackSource>>>,
    albums: Arc<Mutex<HashMap<String, Album>>>,
    track_metadata_cache: Arc<Mutex<HashMap<String, TrackMetadata>>>,
    track_metadata_cache_path: Arc<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct PlaybackSource {
    pub url: String,
    pub mime_type: String,
    pub quality: String,
    pub sampling_rate_khz: Option<f64>,
    pub bit_depth: Option<u32>,
}

struct CachedPlaybackSource {
    source: PlaybackSource,
    cached_at: Instant,
}

impl QobuzProvider {
    /// Qobuz stays optional: an absent login must not prevent Tidal/local startup.
    /// Configure with a saved session, AMBRA_QOBUZ_USER_AUTH_TOKEN, or terminal OAuth.
    pub async fn authenticate_if_configured(interactive: bool) -> ProviderResult<Option<Self>> {
        let saved_session = if session_path().is_file() {
            Some(load_session()?)
        } else {
            None
        };
        let environment_token = env::var("AMBRA_QOBUZ_USER_AUTH_TOKEN")
            .ok()
            .filter(|token| !token.trim().is_empty());
        let interactive = interactive || env_flag("AMBRA_QOBUZ_INTERACTIVE_LOGIN");

        if saved_session.is_none() && environment_token.is_none() && !interactive {
            return Ok(None);
        }

        let client = QobuzClient::new()?;
        client.init().await?;

        let session = if let Some(token) = environment_token {
            client.login_with_token(token.trim()).await?
        } else if interactive {
            interactive_login(&client).await?
        } else if let Some(session) = saved_session {
            client.login_with_token(&session.user_auth_token).await?
        } else {
            return Ok(None);
        };
        save_session(&session)?;

        let track_metadata_cache_path = track_metadata_cache_path();
        let track_metadata_cache = load_track_metadata_cache(&track_metadata_cache_path);

        println!("Qobuz logged in as {}", session.display_name);
        Ok(Some(Self {
            client: Arc::new(client),
            preferred_quality: Quality::UltraHiRes,
            playback_sources: Arc::new(Mutex::new(HashMap::new())),
            albums: Arc::new(Mutex::new(HashMap::new())),
            track_metadata_cache: Arc::new(Mutex::new(track_metadata_cache)),
            track_metadata_cache_path: Arc::new(track_metadata_cache_path),
        }))
    }

    pub async fn album_track_ids(&self, album_id: &str) -> ProviderResult<Vec<String>> {
        validate_album_id(album_id)?;
        let album = self.client.get_album(album_id).await?;
        let track_ids = album
            .tracks
            .as_ref()
            .map(|tracks| {
                tracks
                    .items
                    .iter()
                    .map(|track| track.id.to_string())
                    .collect()
            })
            .unwrap_or_default();
        self.albums.lock().await.insert(album_id.to_owned(), album);
        Ok(track_ids)
    }

    pub async fn search_catalog(
        &self,
        query: &str,
        limit: u32,
    ) -> ProviderResult<crate::models::CatalogSearchPage> {
        use crate::models::{CatalogAlbum, CatalogArtist, CatalogSearchPage};
        let response = self.client.catalog_search(query, limit, 0).await?;
        if !response.get("tracks").is_some()
            && !response.get("artists").is_some()
            && !response.get("albums").is_some()
        {
            return Err(io::Error::other("Qobuz catalog search did not return a catalog").into());
        }
        let items = |section: &str| {
            response
                .get(section)
                .and_then(|v| v.get("items"))
                .cloned()
                .unwrap_or_else(|| serde_json::json!([]))
        };
        let tracks: Vec<Track> = serde_json::from_value(items("tracks"))?;
        let artists: Vec<Artist> = serde_json::from_value(items("artists"))?;
        let albums: Vec<Album> = serde_json::from_value(items("albums"))?;
        Ok(CatalogSearchPage {
            tracks: tracks
                .into_iter()
                .filter(|track| track.streamable)
                .map(map_search_track)
                .collect(),
            artists: artists
                .into_iter()
                .map(|artist| CatalogArtist {
                    id: format!("qobuz:{}", artist.id),
                    provider: MusicProvider::Qobuz,
                    name: artist.name,
                    image_url: artist.image.and_then(|image| image.best().cloned()),
                })
                .collect(),
            albums: albums
                .into_iter()
                .filter(|album| album.streamable != Some(false))
                .map(|album| CatalogAlbum {
                    id: format!("qobuz:{}", album.id),
                    provider: MusicProvider::Qobuz,
                    title: album.title,
                    artist: album.artist.name,
                    image_url: album.image.best().cloned(),
                    upc: album.upc,
                    release_date: album.release_date_original,
                    version: album.version,
                    explicit: album.parental_warning,
                    maximum_bit_depth: album.maximum_bit_depth,
                    maximum_sampling_rate_khz: album
                        .maximum_sampling_rate
                        .and_then(normalize_sampling_rate),
                })
                .collect(),
        })
    }

    pub async fn search_tracks(
        &self,
        query: &str,
        limit: u32,
        offset: u32,
    ) -> ProviderResult<SearchPage> {
        let page = self
            .client
            .search_tracks(query, limit, offset, None)
            .await?;
        let next_offset = search_next_offset(offset, page.items.len(), page.total);
        let tracks = page
            .items
            .into_iter()
            .filter(|track| track.streamable)
            .map(map_search_track)
            .collect();
        Ok(SearchPage {
            tracks,
            next_offset,
        })
    }

    pub async fn exact_album_artwork_by_upc(&self, upc: &str) -> ProviderResult<Option<String>> {
        let albums = self.client.search_albums(upc, 10, 0, None).await?;
        Ok(albums
            .items
            .into_iter()
            .find(|album| {
                album
                    .upc
                    .as_deref()
                    .is_some_and(|candidate| same_release_upc(upc, candidate))
            })
            .and_then(|album| album.image.best().cloned())
            .and_then(|url| qobuz_max_artwork_url(&url)))
    }

    pub async fn track_metadata(&self, track_id: &str) -> ProviderResult<TrackMetadata> {
        let numeric_track_id = validate_track_id(track_id)?;

        {
            let cache = self.track_metadata_cache.lock().await;
            if let Some(cached) = cache.get(track_id) {
                return Ok(cached.clone());
            }
        }

        let track = self.client.get_track(numeric_track_id).await?;
        if !track.streamable {
            return Err(io::Error::other("Qobuz reports that this track is not streamable").into());
        }

        let full_album = match track.album.as_ref() {
            Some(summary) => self.album(&summary.id).await.ok(),
            None => None,
        };
        let playback_source = self.playback_source(track_id).await?;
        let metadata = map_track(track_id, track, full_album.as_ref(), &playback_source);

        let mut cache = self.track_metadata_cache.lock().await;
        cache.insert(track_id.to_owned(), metadata.clone());
        if let Err(error) = save_track_metadata_cache(&self.track_metadata_cache_path, &cache) {
            eprintln!("Could not persist Qobuz metadata cache: {error}");
        }
        Ok(metadata)
    }

    pub async fn playback_source(&self, track_id: &str) -> ProviderResult<PlaybackSource> {
        let numeric_track_id = validate_track_id(track_id)?;

        {
            let cache = self.playback_sources.lock().await;
            if let Some(cached) = cache.get(track_id)
                && cached.cached_at.elapsed() < PLAYBACK_SOURCE_TTL
            {
                return Ok(cached.source.clone());
            }
        }

        let stream = self
            .client
            .get_stream_url_with_fallback(numeric_track_id, self.preferred_quality)
            .await?;
        let source = PlaybackSource {
            url: stream.url,
            mime_type: nonempty(stream.mime_type).unwrap_or_else(|| "audio/flac".to_owned()),
            quality: stream_quality_label(stream.format_id, stream.sampling_rate, stream.bit_depth),
            sampling_rate_khz: normalize_sampling_rate(stream.sampling_rate),
            bit_depth: stream.bit_depth,
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

    async fn album(&self, album_id: &str) -> ProviderResult<Album> {
        if let Some(album) = self.albums.lock().await.get(album_id).cloned() {
            return Ok(album);
        }
        let album = self.client.get_album(album_id).await?;
        self.albums
            .lock()
            .await
            .insert(album_id.to_owned(), album.clone());
        Ok(album)
    }
}

fn map_search_track(track: Track) -> TrackMetadata {
    let track_id = track.id.to_string();
    let primary_artist = track
        .performer
        .as_ref()
        .map(artist_metadata)
        .unwrap_or_else(unknown_artist);
    let artists = vec![primary_artist.clone()];
    let album = track.album.as_ref().map(|summary| AlbumMetadata {
        provider_id: summary.id.clone(),
        title: summary.title.clone(),
        version: None,
        artists: artists.clone(),
        cover_url: summary.image.best().cloned(),
        release_date: None,
        label: summary.label.as_ref().map(|label| label.name.clone()),
        genres: summary
            .genre
            .as_ref()
            .map(|genre| vec![genre.name.clone()])
            .unwrap_or_default(),
        upc: None,
    });
    let quality = match (track.maximum_bit_depth, track.maximum_sampling_rate) {
        (Some(depth), Some(rate)) => stream_quality_label(
            if depth > 16 {
                if normalize_sampling_rate(rate).is_some_and(|rate| rate > 96.0) {
                    Quality::UltraHiRes.id()
                } else {
                    Quality::HiRes.id()
                }
            } else {
                Quality::Lossless.id()
            },
            rate,
            Some(depth),
        ),
        _ => {
            if track.hires {
                Quality::HiRes.label().to_owned()
            } else {
                Quality::Lossless.label().to_owned()
            }
        }
    };

    TrackMetadata {
        id: format!("qobuz:{track_id}"),
        provider: MusicProvider::Qobuz,
        provider_track_id: track_id.clone(),
        title: track.title,
        version: track.version,
        primary_artist,
        artists,
        album,
        duration_seconds: u64::from(track.duration),
        track_number: nonzero(track.track_number),
        disc_number: track.media_number.and_then(nonzero),
        explicit: track.parental_warning,
        isrc: track.isrc,
        copyright: track.copyright,
        quality: Some(quality),
        maximum_sampling_rate_khz: track
            .maximum_sampling_rate
            .and_then(normalize_sampling_rate),
        maximum_bit_depth: track.maximum_bit_depth,
        playback: PlaybackMetadata {
            kind: PlaybackKind::Direct,
            url: format!("/api/providers/qobuz/tracks/{track_id}/stream"),
        },
    }
}

fn map_track(
    track_id: &str,
    track: Track,
    full_album: Option<&Album>,
    source: &PlaybackSource,
) -> TrackMetadata {
    let primary_artist = track
        .performer
        .as_ref()
        .map(artist_metadata)
        .or_else(|| full_album.map(|album| artist_metadata(&album.artist)))
        .unwrap_or_else(unknown_artist);
    let artists = vec![primary_artist.clone()];
    let album = track.album.as_ref().map(|summary| {
        let album_artists = full_album
            .map(album_artists)
            .filter(|artists| !artists.is_empty())
            .unwrap_or_else(|| vec![primary_artist.clone()]);
        AlbumMetadata {
            provider_id: summary.id.clone(),
            title: summary.title.clone(),
            version: full_album.and_then(|album| album.version.clone()),
            artists: album_artists,
            cover_url: full_album
                .and_then(|album| album.image.best().cloned())
                .or_else(|| summary.image.best().cloned()),
            release_date: full_album.and_then(|album| {
                album
                    .dates
                    .as_ref()
                    .and_then(|dates| dates.original.clone())
                    .or_else(|| album.release_date_original.clone())
            }),
            label: full_album
                .and_then(|album| album.label.as_ref())
                .map(|label| label.name.clone())
                .or_else(|| summary.label.as_ref().map(|label| label.name.clone())),
            genres: full_album
                .and_then(|album| album.genre.as_ref())
                .or(summary.genre.as_ref())
                .map(|genre| vec![genre.name.clone()])
                .unwrap_or_default(),
            upc: full_album.and_then(|album| album.upc.clone()),
        }
    });

    TrackMetadata {
        id: format!("qobuz:{track_id}"),
        provider: MusicProvider::Qobuz,
        provider_track_id: track_id.to_owned(),
        title: track.title,
        version: track.version,
        primary_artist,
        artists,
        album,
        duration_seconds: u64::from(track.duration),
        track_number: nonzero(track.track_number),
        disc_number: track.media_number.and_then(nonzero),
        explicit: track.parental_warning,
        isrc: track.isrc,
        copyright: track.copyright,
        quality: Some(source.quality.clone()),
        maximum_sampling_rate_khz: track.maximum_sampling_rate.or(source.sampling_rate_khz),
        maximum_bit_depth: track.maximum_bit_depth.or(source.bit_depth),
        playback: PlaybackMetadata {
            kind: PlaybackKind::Direct,
            url: format!("/api/providers/qobuz/tracks/{track_id}/stream"),
        },
    }
}

fn album_artists(album: &Album) -> Vec<ArtistMetadata> {
    let mut artists = vec![artist_metadata(&album.artist)];
    if let Some(contributors) = album.artists.as_ref() {
        for contributor in contributors {
            push_unique_artist(
                &mut artists,
                ArtistMetadata {
                    provider_id: contributor.id.to_string(),
                    name: contributor.name.clone(),
                    image_url: None,
                },
            );
        }
    }
    artists.retain(|artist| !artist.name.is_empty());
    artists
}

fn artist_metadata(artist: &Artist) -> ArtistMetadata {
    ArtistMetadata {
        provider_id: artist.id.to_string(),
        name: artist.name.clone(),
        image_url: artist
            .image
            .as_ref()
            .and_then(|images| images.best().cloned()),
    }
}

fn unknown_artist() -> ArtistMetadata {
    ArtistMetadata {
        provider_id: String::new(),
        name: "Unknown Artist".to_owned(),
        image_url: None,
    }
}

fn push_unique_artist(artists: &mut Vec<ArtistMetadata>, artist: ArtistMetadata) {
    if !artist.name.is_empty()
        && !artists.iter().any(|existing| {
            (!artist.provider_id.is_empty() && existing.provider_id == artist.provider_id)
                || existing.name.eq_ignore_ascii_case(&artist.name)
        })
    {
        artists.push(artist);
    }
}

fn stream_quality_label(format_id: u32, sampling_rate: f64, bit_depth: Option<u32>) -> String {
    let codec = if format_id == Quality::Mp3.id() {
        "MP3"
    } else {
        "FLAC"
    };
    match (bit_depth, normalize_sampling_rate(sampling_rate)) {
        (Some(depth), Some(rate)) => {
            let rate = if rate.fract() == 0.0 {
                format!("{rate:.0}")
            } else {
                format!("{rate:.1}")
            };
            format!("{codec} {depth}-bit/{rate} kHz")
        }
        (Some(depth), None) => format!("{codec} {depth}-bit"),
        _ => Quality::from_id(format_id)
            .map(|quality| quality.label().to_owned())
            .unwrap_or_else(|| codec.to_owned()),
    }
}

fn normalize_sampling_rate(rate: f64) -> Option<f64> {
    if !rate.is_finite() || rate <= 0.0 {
        None
    } else if rate >= 1_000.0 {
        Some(rate / 1_000.0)
    } else {
        Some(rate)
    }
}

fn nonzero(value: u32) -> Option<u32> {
    (value > 0).then_some(value)
}

fn nonempty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

async fn interactive_login(client: &QobuzClient) -> ProviderResult<UserSession> {
    let app_id = client.app_id().await?;
    let login_url = format!(
        "https://www.qobuz.com/signin/oauth?ext_app_id={app_id}&redirect_url={}",
        urlencoding::encode(OAUTH_REDIRECT_URL)
    );
    println!(
        "Open this URL and sign in to Qobuz:\n{login_url}\n\n\
         The redirect page may fail to load; copy its full URL from the address bar."
    );
    print!("Paste the full callback URL (or authorization code): ");
    io::stdout().flush()?;

    let mut callback = String::new();
    io::stdin().read_line(&mut callback)?;
    let code = oauth_code(callback.trim())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "No Qobuz OAuth code found"))?;
    Ok(client.login_with_oauth_code(&code).await?)
}

fn oauth_code(input: &str) -> Option<String> {
    if input.is_empty() {
        return None;
    }
    if !input.contains("?") {
        return (!input.contains("://")).then(|| input.to_owned());
    }
    let query = input.split_once('?')?.1.split('#').next()?;
    let mut fallback = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        let decoded = urlencoding::decode(value).ok()?.into_owned();
        if key == "code_autorisation" {
            return Some(decoded);
        }
        if key == "code" {
            fallback = Some(decoded);
        }
    }
    fallback
}

fn env_flag(name: &str) -> bool {
    env::var(name).is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn validate_track_id(track_id: &str) -> ProviderResult<u64> {
    Ok(track_id.parse::<u64>().map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("'{track_id}' is not a numeric Qobuz track ID"),
        )
    })?)
}

fn validate_album_id(album_id: &str) -> ProviderResult<()> {
    if album_id.is_empty()
        || !album_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("'{album_id}' is not a valid Qobuz album ID"),
        )
        .into());
    }
    Ok(())
}

fn session_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".qobuz-session.json")
}

fn load_session() -> ProviderResult<UserSession> {
    Ok(serde_json::from_slice(&fs::read(session_path())?)?)
}

fn save_session(session: &UserSession) -> ProviderResult<()> {
    write_private_json(&session_path(), session)
}

fn track_metadata_cache_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".qobuz-metadata-cache.json")
}

fn load_track_metadata_cache(path: &Path) -> HashMap<String, TrackMetadata> {
    let encoded = match fs::read(path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return HashMap::new(),
        Err(error) => {
            eprintln!("Could not read Qobuz metadata cache: {error}");
            return HashMap::new();
        }
    };
    serde_json::from_slice(&encoded).unwrap_or_else(|error| {
        eprintln!("Could not decode Qobuz metadata cache: {error}");
        HashMap::new()
    })
}

fn save_track_metadata_cache(
    path: &Path,
    cache: &HashMap<String, TrackMetadata>,
) -> ProviderResult<()> {
    write_private_json(path, cache)
}

fn write_private_json(path: &Path, value: &impl serde::Serialize) -> ProviderResult<()> {
    let temporary_path = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary_path)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    fs::rename(temporary_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalize_sampling_rate, oauth_code, stream_quality_label};

    #[test]
    fn extracts_oauth_code_from_qobuz_callback() {
        assert_eq!(
            oauth_code("http://127.0.0.1:8788/qobuz?code_autorisation=a%2Bb"),
            Some("a+b".to_owned())
        );
        assert_eq!(oauth_code("bare-code"), Some("bare-code".to_owned()));
    }

    #[test]
    fn normalizes_hz_and_khz_rates() {
        assert_eq!(normalize_sampling_rate(192_000.0), Some(192.0));
        assert_eq!(normalize_sampling_rate(96.0), Some(96.0));
    }

    #[test]
    fn labels_delivered_stream_quality() {
        assert_eq!(
            stream_quality_label(27, 192.0, Some(24)),
            "FLAC 24-bit/192 kHz"
        );
    }
}

#[cfg(test)]
mod transport_tests {
    use qbz_qobuz::QobuzClient;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn qobuz_client_negotiates_and_decodes_gzip() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0 && request.len() < 8192);
                request.extend_from_slice(&chunk[..count]);
            }
            let request = String::from_utf8(request).unwrap().to_lowercase();
            assert!(
                request
                    .lines()
                    .any(|line| line.starts_with("accept-encoding:") && line.contains("gzip"))
            );
            let body: &[u8] = &[
                31, 139, 8, 0, 0, 0, 0, 0, 2, 255, 171, 86, 202, 207, 86, 178, 42, 41, 42, 77, 173,
                5, 0, 144, 95, 212, 167, 11, 0, 0, 0,
            ];
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(body).await.unwrap();
        });
        let client = QobuzClient::new().unwrap();
        let response: serde_json::Value = client
            .get_http()
            .get(format!("http://{address}/search"))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(response["ok"], true);
        server.await.unwrap();
    }
}
