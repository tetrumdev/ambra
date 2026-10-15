use super::{LyricsRequest, formats, model::LyricsResponse, ttml};
use futures_util::StreamExt;
use serde::{Deserialize, de::DeserializeOwned};
use std::{
    io,
    sync::LazyLock,
    time::{Duration, SystemTime},
};
use tokio::{sync::Mutex, time::Instant};

#[derive(Clone, Copy)]
pub(super) enum Provider {
    Amll,
    Red,
    Lrclib,
}

impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Self::Amll => "amll",
            Self::Red => "lrc.red",
            Self::Lrclib => "lrclib",
        }
    }
    fn index(self) -> usize {
        match self {
            Self::Amll => 0,
            Self::Red => 1,
            Self::Lrclib => 2,
        }
    }
}

pub(super) struct RateState {
    next: Instant,
}
impl Default for RateState {
    fn default() -> Self {
        Self {
            next: Instant::now(),
        }
    }
}
static RATES: LazyLock<[Mutex<RateState>; 3]> =
    LazyLock::new(|| std::array::from_fn(|_| Mutex::new(RateState::default())));

pub(super) struct ProviderClient<'a> {
    pub http: &'a reqwest::Client,
    pub bases: [&'a str; 3],
    pub rates: &'a [Mutex<RateState>; 3],
    pub budget: Duration,
}

impl<'a> ProviderClient<'a> {
    pub fn new(http: &'a reqwest::Client) -> Self {
        Self {
            http,
            bases: [
                "https://api.amll.dev",
                "https://lrc.red",
                "https://lrclib.net",
            ],
            rates: &RATES,
            budget: Duration::from_secs(6),
        }
    }

    pub async fn fetch(
        &self,
        provider: Provider,
        request: &LyricsRequest,
    ) -> Result<Option<LyricsResponse>, io::Error> {
        let mut best = None;
        let result = tokio::time::timeout(self.budget, async {
            match provider {
                Provider::Amll => self.amll(request, &mut best).await,
                Provider::Red => self.red(request, &mut best).await,
                Provider::Lrclib => self.lrclib(request, &mut best).await,
            }
        })
        .await;
        // A later search failure must never discard an already validated result.
        if best.is_some() {
            return Ok(best);
        }
        result
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Lyrics provider timed out"))??;
        Ok(None)
    }

    async fn body(
        &self,
        provider: Provider,
        path: &str,
        query: &[(&str, String)],
        json: bool,
    ) -> Result<Option<Vec<u8>>, io::Error> {
        let mut rate = self.rates[provider.index()].lock().await;
        if rate.next.saturating_duration_since(Instant::now()) > Duration::from_secs(1) {
            return Err(io::Error::other("Lyrics provider is cooling down"));
        }
        tokio::time::sleep_until(rate.next).await;
        // Reserve spacing before sending, so cancellation still respects throttling.
        rate.next = Instant::now() + Duration::from_millis(250);
        let response = self
            .http
            .get(format!("{}{path}", self.bases[provider.index()]))
            .header(
                reqwest::header::USER_AGENT,
                concat!("Ambra/", env!("CARGO_PKG_VERSION")),
            )
            .header(reqwest::header::CACHE_CONTROL, "no-store")
            .query(query)
            .timeout(Duration::from_secs(4))
            .send()
            .await
            .map_err(io::Error::other)?;
        if matches!(
            response.status(),
            reqwest::StatusCode::TOO_MANY_REQUESTS | reqwest::StatusCode::SERVICE_UNAVAILABLE
        ) {
            let delay = retry_after(
                response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok()),
                SystemTime::now(),
            );
            rate.next = Instant::now()
                .checked_add(delay)
                .unwrap_or(Instant::now() + Duration::from_secs(86_400));
            return Err(io::Error::other(
                "Lyrics provider rate limited or unavailable",
            ));
        }
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let response = response.error_for_status().map_err(io::Error::other)?;
        if json
            && !response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value
                        .split(';')
                        .next()
                        .is_some_and(|mime| mime.trim() == "application/json")
                })
        {
            return Err(io::Error::other("Expected a JSON lyrics response"));
        }
        if response
            .content_length()
            .is_some_and(|size| size > formats::MAX_RESPONSE_BYTES as u64)
        {
            return Err(io::Error::other("Lyrics response is too large"));
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(io::Error::other)?;
            if body.len() + chunk.len() > formats::MAX_RESPONSE_BYTES {
                return Err(io::Error::other("Lyrics response is too large"));
            }
            body.extend_from_slice(&chunk);
        }
        rate.next = Instant::now() + Duration::from_millis(250);
        Ok(Some(body))
    }

    async fn json<T: DeserializeOwned>(
        &self,
        provider: Provider,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Option<T>, io::Error> {
        self.body(provider, path, query, true)
            .await?
            .map(|body| serde_json::from_slice(&body).map_err(io::Error::other))
            .transpose()
    }

    async fn amll(
        &self,
        request: &LyricsRequest,
        best: &mut Option<LyricsResponse>,
    ) -> Result<(), io::Error> {
        let mut ids = Vec::new();
        if let Some(isrc) = &request.isrc {
            ids.push(("isrc", isrc.to_ascii_uppercase()));
        }
        if let Some(id) = &request.spotify_id {
            ids.push(("spotifyId", id.clone()));
        }
        if let Some(id) = &request.apple_music_id {
            ids.push(("appleMusicId", id.clone()));
        }
        let mut seen = Vec::new();
        let mut parse_error = None;
        for id in ids {
            if let Some(envelope) = self
                .json::<Envelope<AmllRecord>>(Provider::Amll, "/v1/lyrics/get", &[id])
                .await?
            {
                let record = envelope.data;
                seen.push(record.id);
                if record.score(request).is_some() {
                    match self.amll_record(record, request, best) {
                        Ok(true) => return Ok(()),
                        Ok(false) => {}
                        Err(error) => parse_error = Some(error),
                    }
                }
            }
        }
        let query = [
            ("musicName", request.track_name.trim().to_owned()),
            ("artistName", request.artist_name.trim().to_owned()),
            ("pageSize", "20".to_owned()),
        ];
        let Some(envelope) = self
            .json::<Envelope<AmllSearch>>(Provider::Amll, "/v1/lyrics/search", &query)
            .await?
        else {
            return Ok(());
        };
        let mut candidates: Vec<_> = envelope
            .data
            .items
            .into_iter()
            .filter_map(|record| record.score(request).map(|score| (score, record)))
            .collect();
        candidates.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, candidate) in candidates
            .into_iter()
            .filter(|(_, record)| !seen.contains(&record.id))
            .take(3)
        {
            if let Some(envelope) = self
                .json::<Envelope<AmllRecord>>(
                    Provider::Amll,
                    "/v1/lyrics/get",
                    &[("id", candidate.id.to_string())],
                )
                .await?
            {
                let record = envelope.data;
                if record.id == candidate.id && record.score(request).is_some() {
                    match self.amll_record(record, request, best) {
                        Ok(true) => return Ok(()),
                        Ok(false) => {}
                        Err(error) => parse_error = Some(error),
                    }
                }
            }
        }
        if let Some(error) = parse_error {
            return Err(error);
        }
        Ok(())
    }

    fn amll_record(
        &self,
        record: AmllRecord,
        request: &LyricsRequest,
        best: &mut Option<LyricsResponse>,
    ) -> Result<bool, io::Error> {
        let Some(raw) = record.lyrics else {
            return Ok(false);
        };
        let mut lyrics = ttml::parse(&raw, request.duration_ms())?;
        if request.duration_ms().is_some_and(|duration| {
            lyrics
                .lines
                .iter()
                .flat_map(|line| std::iter::once(line).chain(line.background_vocals.iter()))
                .any(|line| {
                    line.start_ms.is_some_and(|start| start > duration + 5000)
                        || line.end_ms.is_some_and(|end| end > duration + 5000)
                })
        }) {
            return Err(io::Error::other(
                "AMLL timing exceeds the recording duration",
            ));
        }
        lyrics.source = Some(Provider::Amll.name());
        Ok(keep(best, lyrics))
    }

    async fn red(
        &self,
        request: &LyricsRequest,
        best: &mut Option<LyricsResponse>,
    ) -> Result<(), io::Error> {
        if let Some(isrc) = &request.isrc {
            // ISRC is the catalog's recording identity; no search or metadata request is needed.
            self.red_record(&isrc.to_ascii_uppercase(), request, best)
                .await?;
            return Ok(());
        }
        let query = [(
            "q",
            format!(
                "{} {}",
                request.track_name.trim(),
                request.artist_name.trim()
            ),
        )];
        let Some(search) = self
            .json::<RedSearch>(Provider::Red, "/search.json", &query)
            .await?
        else {
            return Ok(());
        };
        let mut candidates: Vec<_> = search
            .hits
            .into_iter()
            .filter(|record| valid_isrc(&record.isrc))
            .filter_map(|record| record.score(request).map(|score| (score, record)))
            .collect();
        candidates.sort_by(|a, b| b.0.cmp(&a.0));
        let mut parse_error = None;
        for (_, record) in candidates.into_iter().take(3) {
            if let Err(error) = self.red_record(&record.isrc, request, best).await {
                parse_error = Some(error);
            }
            if best.as_ref().is_some_and(|lyrics| lyrics.has_word_sync) {
                break;
            }
        }
        if let Some(error) = parse_error {
            return Err(error);
        }
        Ok(())
    }

    async fn red_record(
        &self,
        isrc: &str,
        request: &LyricsRequest,
        best: &mut Option<LyricsResponse>,
    ) -> Result<(), io::Error> {
        let mut parse_error = None;
        for extension in ["ttml", "lyricsfile.yaml", "lrc"] {
            let Some(body) = self
                .body(Provider::Red, &format!("/s/{isrc}.{extension}"), &[], false)
                .await?
            else {
                continue;
            };
            let raw = match std::str::from_utf8(&body) {
                Ok(raw) => raw,
                Err(error) => {
                    parse_error = Some(io::Error::other(error));
                    continue;
                }
            };
            let result = match extension {
                "ttml" => ttml::parse(raw, request.duration_ms()),
                "lyricsfile.yaml" => formats::lyricsfile(raw, request.duration_ms()),
                _ => formats::lrc(raw, request.duration_ms()),
            };
            match result {
                Ok(mut lyrics) if lyrics.status != "unavailable" => {
                    lyrics.source = Some(Provider::Red.name());
                    keep(best, lyrics);
                    return Ok(());
                }
                Ok(_) => {}
                Err(error) => parse_error = Some(error),
            }
        }
        if let Some(error) = parse_error {
            return Err(error);
        }
        Ok(())
    }

    async fn lrclib(
        &self,
        request: &LyricsRequest,
        best: &mut Option<LyricsResponse>,
    ) -> Result<(), io::Error> {
        let mut query = vec![
            ("track_name", request.title()),
            ("artist_name", request.artist_name.trim().to_owned()),
        ];
        if !request.album_name.trim().is_empty() {
            query.push(("album_name", request.album_name.trim().to_owned()));
        }
        if let Some(duration) = request
            .duration_seconds
            .filter(|value| (1.0..=3600.0).contains(value))
        {
            query.push(("duration", duration.to_string()));
        }
        if let Some(record) = self
            .json::<LrclibRecord>(Provider::Lrclib, "/api/get", &query)
            .await?
        {
            if record.score(request).is_some() {
                let lyrics = record.parse(request.duration_ms());
                if keep(best, lyrics)
                    || best
                        .as_ref()
                        .is_some_and(|lyrics| lyrics.status == "instrumental")
                {
                    return Ok(());
                }
            }
        }
        // /get may choose a line-only revision even when search contains a word-timed one.
        query.retain(|(name, _)| matches!(*name, "track_name" | "artist_name"));
        let Some(records) = self
            .json::<Vec<LrclibRecord>>(Provider::Lrclib, "/api/search", &query)
            .await?
        else {
            return Ok(());
        };
        let mut candidates: Vec<_> = records
            .into_iter()
            .filter_map(|record| record.score(request).map(|score| (score, record)))
            .collect();
        candidates.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, record) in candidates.into_iter().take(20) {
            if keep(best, record.parse(request.duration_ms())) {
                break;
            }
        }
        Ok(())
    }
}

pub(super) fn retry_after(value: Option<&str>, now: SystemTime) -> Duration {
    value
        .and_then(|value| {
            value
                .parse::<u64>()
                .ok()
                .map(Duration::from_secs)
                .or_else(|| {
                    httpdate::parse_http_date(value)
                        .ok()
                        .map(|date| date.duration_since(now).unwrap_or_default())
                })
        })
        .unwrap_or(Duration::from_secs(5))
}

fn keep(best: &mut Option<LyricsResponse>, lyrics: LyricsResponse) -> bool {
    let detail = lyrics.has_word_sync;
    let rank = |lyrics: &LyricsResponse| match lyrics.status {
        "instrumental" => 1,
        "lyrics" if lyrics.has_word_sync => 4,
        "lyrics" if lyrics.sync == "line" => 3,
        "lyrics" => 2,
        _ => 0,
    };
    if rank(&lyrics) > best.as_ref().map(rank).unwrap_or(0) {
        *best = Some(lyrics);
    }
    detail
}

pub(super) fn normalized(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

pub(super) fn valid_isrc(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 12
        && bytes[..2].iter().all(u8::is_ascii_alphabetic)
        && bytes[2..5].iter().all(u8::is_ascii_alphanumeric)
        && bytes[5..].iter().all(u8::is_ascii_digit)
}

struct Recording<'a> {
    titles: &'a [String],
    artists: &'a [String],
    albums: &'a [String],
    duration: Option<f64>,
    isrcs: &'a [String],
    spotify_ids: &'a [String],
    apple_music_ids: &'a [String],
}

impl Recording<'_> {
    fn score(&self, request: &LyricsRequest) -> Option<u32> {
        if self
            .duration
            .is_some_and(|duration| !duration.is_finite() || !(0.0..=86_400.0).contains(&duration))
        {
            return None;
        }
        let isrc_match = request.isrc.as_ref().is_some_and(|isrc| {
            self.isrcs
                .iter()
                .any(|value| value.eq_ignore_ascii_case(isrc))
        });
        if request.isrc.is_some() && !self.isrcs.is_empty() && !isrc_match {
            return None;
        }
        let id_match = isrc_match
            || request
                .spotify_id
                .as_ref()
                .is_some_and(|id| self.spotify_ids.contains(id))
            || request
                .apple_music_id
                .as_ref()
                .is_some_and(|id| self.apple_music_ids.contains(id));
        let album_match = !request.album_name.trim().is_empty()
            && self
                .albums
                .iter()
                .any(|album| normalized(album) == normalized(&request.album_name));
        let duration_match = match (
            request.duration_seconds.filter(|value| *value > 0.0),
            self.duration,
        ) {
            (Some(expected), Some(actual)) => {
                if !actual.is_finite()
                    || actual <= 0.0
                    || (actual - expected).abs() > (expected * 0.01).clamp(2.0, 5.0)
                {
                    return None;
                }
                true
            }
            _ => false,
        };
        if id_match {
            return Some(100 + u32::from(album_match));
        }
        let title = normalized(&request.title());
        let artist = normalized(&request.artist_name);
        if title.is_empty()
            || artist.is_empty()
            || !self.titles.iter().any(|value| normalized(value) == title)
            || !self.artists.iter().any(|value| normalized(value) == artist)
            || (!album_match && !duration_match)
        {
            return None;
        }
        Some(10 + u32::from(album_match) * 5 + u32::from(duration_match) * 3)
    }
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}
#[derive(Deserialize)]
struct AmllSearch {
    items: Vec<AmllRecord>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AmllRecord {
    id: u64,
    music_names: Vec<String>,
    artist_names: Vec<String>,
    album_names: Vec<String>,
    #[serde(default)]
    isrcs: Vec<String>,
    #[serde(default)]
    spotify_ids: Vec<String>,
    #[serde(default)]
    apple_music_ids: Vec<String>,
    lyrics: Option<String>,
}
impl AmllRecord {
    pub fn score(&self, request: &LyricsRequest) -> Option<u32> {
        Recording {
            titles: &self.music_names,
            artists: &self.artist_names,
            albums: &self.album_names,
            duration: None,
            isrcs: &self.isrcs,
            spotify_ids: &self.spotify_ids,
            apple_music_ids: &self.apple_music_ids,
        }
        .score(request)
    }
}

#[derive(Deserialize)]
struct RedSearch {
    hits: Vec<RedRecord>,
}
#[derive(Deserialize)]
pub(super) struct RedRecord {
    isrc: String,
    title: String,
    artist: String,
    album: String,
    duration: f64,
}
impl RedRecord {
    pub fn score(&self, request: &LyricsRequest) -> Option<u32> {
        Recording {
            titles: std::slice::from_ref(&self.title),
            artists: std::slice::from_ref(&self.artist),
            albums: std::slice::from_ref(&self.album),
            duration: Some(self.duration),
            isrcs: std::slice::from_ref(&self.isrc),
            spotify_ids: &[],
            apple_music_ids: &[],
        }
        .score(request)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LrclibRecord {
    track_name: String,
    artist_name: String,
    album_name: String,
    duration: f64,
    instrumental: bool,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
    lyricsfile: Option<String>,
    // hasWordSync is intentionally not trusted. Timing data is inspected instead.
}
impl LrclibRecord {
    pub fn score(&self, request: &LyricsRequest) -> Option<u32> {
        Recording {
            titles: std::slice::from_ref(&self.track_name),
            artists: std::slice::from_ref(&self.artist_name),
            albums: std::slice::from_ref(&self.album_name),
            duration: Some(self.duration),
            isrcs: &[],
            spotify_ids: &[],
            apple_music_ids: &[],
        }
        .score(request)
    }
    pub fn parse(self, duration_ms: Option<u64>) -> LyricsResponse {
        let mut lyrics = if self.instrumental {
            LyricsResponse::empty(Some(true))
        } else {
            let duration = duration_ms.or_else(|| {
                (self.duration.is_finite() && self.duration > 0.0)
                    .then_some((self.duration * 1000.0).round() as u64)
            });
            let mut lyrics = self
                .lyricsfile
                .as_deref()
                .and_then(|raw| formats::lyricsfile(raw, duration).ok())
                .unwrap_or_else(|| LyricsResponse::empty(Some(false)));
            if lyrics.sync == "none" && lyrics.status != "instrumental" {
                if let Some(mut lrc) = self
                    .synced_lyrics
                    .as_deref()
                    .and_then(|raw| formats::lrc(raw, duration).ok())
                    .filter(|lrc| lrc.status == "lyrics")
                {
                    lrc.plain_lyrics = lyrics.plain_lyrics.take();
                    lyrics = lrc;
                }
            }
            if lyrics.status != "instrumental" {
                lyrics.plain_lyrics = lyrics.plain_lyrics.or(self.plain_lyrics);
                lyrics.original_format = lyrics.original_format.or(Some("plain"));
                lyrics.normalize(duration);
            }
            lyrics
        };
        lyrics.source = Some(Provider::Lrclib.name());
        lyrics
    }
}
