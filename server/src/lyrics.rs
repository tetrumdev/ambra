use std::{io, time::Duration};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsRequest {
    track_name: String,
    artist_name: String,
    #[serde(default)]
    album_name: String,
    duration_seconds: Option<f64>,
}

impl LyricsRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.track_name.trim().is_empty() || self.artist_name.trim().is_empty() {
            return Err("Track title and artist are required");
        }
        if [&self.track_name, &self.artist_name, &self.album_name]
            .iter()
            .any(|value| value.len() > 1000)
        {
            return Err("Track metadata is too long");
        }
        if self
            .duration_seconds
            .is_some_and(|duration| !duration.is_finite() || duration < 0.0)
        {
            return Err("Track duration must be finite and nonnegative");
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResponse {
    status: &'static str,
    instrumental: Option<bool>,
    sync: &'static str,
    has_word_sync: bool,
    plain_lyrics: Option<String>,
    lines: Vec<LyricLine>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrclibRecord {
    instrumental: bool,
    duration: f64,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
    lyricsfile: Option<String>,
}

#[derive(Deserialize)]
struct Lyricsfile {
    version: String,
    metadata: LyricsfileMetadata,
    #[serde(default)]
    lines: Vec<LyricLine>,
    plain: Option<String>,
}

#[derive(Deserialize)]
struct LyricsfileMetadata {
    #[serde(default)]
    instrumental: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct LyricLine {
    text: String,
    start_ms: u64,
    end_ms: Option<u64>,
    #[serde(default)]
    words: Vec<LyricWord>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct LyricWord {
    text: String,
    start_ms: u64,
    end_ms: Option<u64>,
}

impl LyricsResponse {
    fn empty(instrumental: Option<bool>) -> Self {
        Self {
            status: if instrumental == Some(true) {
                "instrumental"
            } else {
                "unavailable"
            },
            instrumental,
            sync: "none",
            has_word_sync: false,
            plain_lyrics: None,
            lines: Vec::new(),
        }
    }

    fn from_record(record: LrclibRecord) -> Self {
        if record.instrumental {
            return Self::empty(Some(true));
        }
        let document = record
            .lyricsfile
            .as_deref()
            .and_then(|raw| serde_yaml_ng::from_str::<Lyricsfile>(raw).ok())
            .filter(|document| document.version == "1.0");
        if document
            .as_ref()
            .is_some_and(|document| document.metadata.instrumental)
        {
            return Self::empty(Some(true));
        }
        let (mut lines, plain) = match document {
            Some(document) => (document.lines, document.plain.or(record.plain_lyrics)),
            None => (Vec::new(), record.plain_lyrics),
        };
        if lines.is_empty() {
            lines = parse_lrc(record.synced_lyrics.as_deref().unwrap_or_default());
        }
        lines.retain(|line| line.end_ms.is_none_or(|end| end >= line.start_ms));
        lines.sort_by_key(|line| line.start_ms);
        let duration_ms = (record.duration.is_finite() && record.duration > 0.0)
            .then_some((record.duration * 1000.0) as u64);
        // Walk equal-start groups backwards so inference stays linear, including
        // overlapping vocals. Explicit ends always take precedence.
        let mut next_start = duration_ms;
        for group in lines
            .chunk_by_mut(|left, right| left.start_ms == right.start_ms)
            .rev()
        {
            let group_start = group[0].start_ms;
            for line in group {
                line.end_ms = line
                    .end_ms
                    .or(next_start.filter(|end| *end >= line.start_ms));
                line.words.sort_by_key(|word| word.start_ms);
                // Preserve the complete line if malformed segments cannot reconstruct it.
                if line
                    .words
                    .iter()
                    .map(|word| word.text.as_str())
                    .collect::<String>()
                    != line.text
                    || line.words.iter().any(|word| {
                        word.start_ms < line.start_ms
                            || line.end_ms.is_some_and(|end| word.start_ms > end)
                            || word.end_ms.is_some_and(|end| end < word.start_ms)
                    })
                {
                    line.words.clear();
                }
                let mut next_word = line.end_ms;
                for words in line
                    .words
                    .chunk_by_mut(|left, right| left.start_ms == right.start_ms)
                    .rev()
                {
                    let word_start = words[0].start_ms;
                    for word in words {
                        word.end_ms = word.end_ms.or(next_word);
                    }
                    next_word = Some(word_start);
                }
            }
            next_start = Some(group_start);
        }
        let plain_lyrics = plain.filter(|plain| !plain.trim().is_empty());
        if !lines.iter().any(|line| !line.text.trim().is_empty()) {
            lines.clear();
        }
        let has_word_sync = lines.iter().any(|line| !line.words.is_empty());
        Self {
            status: if lines.is_empty() && plain_lyrics.is_none() {
                "unavailable"
            } else {
                "lyrics"
            },
            instrumental: Some(false),
            sync: if has_word_sync {
                "word"
            } else if !lines.is_empty() {
                "line"
            } else {
                "none"
            },
            has_word_sync,
            plain_lyrics,
            lines,
        }
    }
}

pub async fn fetch(
    client: &reqwest::Client,
    request: &LyricsRequest,
) -> Result<LyricsResponse, io::Error> {
    let mut query = vec![
        ("track_name", request.track_name.trim().to_owned()),
        ("artist_name", request.artist_name.trim().to_owned()),
    ];
    if !request.album_name.trim().is_empty() {
        query.push(("album_name", request.album_name.trim().to_owned()));
    }
    // LRCLIB accepts optional durations only between 1 and 3600 seconds.
    if let Some(duration) = request
        .duration_seconds
        .filter(|duration| (1.0..=3600.0).contains(duration))
    {
        query.push(("duration", duration.to_string()));
    }
    tokio::time::timeout(Duration::from_secs(12), fetch_record(client, &query))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "LRCLIB request timed out"))?
}

async fn fetch_record(
    client: &reqwest::Client,
    query: &[(&str, String)],
) -> Result<LyricsResponse, io::Error> {
    let mut retried = false;
    loop {
        let response = client
            .get("https://lrclib.net/api/get")
            .header(
                reqwest::header::USER_AGENT,
                concat!("Ambra/", env!("CARGO_PKG_VERSION")),
            )
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .query(query)
            .send()
            .await
            .map_err(io::Error::other)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(LyricsResponse::empty(None));
        }
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(1);
        if !retried
            && retry_after <= 3
            && matches!(
                response.status(),
                reqwest::StatusCode::SERVICE_UNAVAILABLE | reqwest::StatusCode::TOO_MANY_REQUESTS
            )
        {
            retried = true;
            drop(response);
            tokio::time::sleep(Duration::from_secs(retry_after)).await;
            continue;
        }
        let response = response.error_for_status().map_err(io::Error::other)?;
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(io::Error::other)?;
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(io::Error::other("LRCLIB response is too large"));
            }
            body.extend_from_slice(&chunk);
        }
        let record = serde_json::from_slice::<LrclibRecord>(&body).map_err(io::Error::other)?;
        return Ok(LyricsResponse::from_record(record));
    }
}

fn timestamp_ms(value: &str) -> Option<u64> {
    let (minutes, seconds) = value.split_once(':')?;
    let minutes = minutes.parse::<u64>().ok()?;
    let seconds = seconds.parse::<f64>().ok()?;
    if !seconds.is_finite() || !(0.0..60.0).contains(&seconds) {
        return None;
    }
    minutes
        .checked_mul(60_000)?
        .checked_add((seconds * 1000.0).round() as u64)
}

fn parse_lrc(raw: &str) -> Vec<LyricLine> {
    let offset = raw
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("[offset:")
                .and_then(|value| value.strip_suffix(']'))
                .and_then(|value| value.trim().parse::<i64>().ok())
        })
        .unwrap_or(0);
    let mut lines = Vec::new();
    for raw_line in raw.lines() {
        let mut remaining = raw_line.trim();
        let mut starts = Vec::new();
        while let Some(value) = remaining.strip_prefix('[') {
            let Some((tag, rest)) = value.split_once(']') else {
                break;
            };
            let Some(start) = timestamp_ms(tag) else {
                break;
            };
            // Positive LRC offsets advance the lyrics relative to the audio.
            starts.push(start.saturating_sub_signed(offset));
            remaining = rest;
        }
        for start_ms in starts {
            lines.push(LyricLine {
                text: remaining.trim().to_owned(),
                start_ms,
                end_ms: None,
                words: Vec::new(),
            });
        }
    }
    lines
}
