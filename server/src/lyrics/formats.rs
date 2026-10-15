use super::model::{LyricLine, LyricsResponse, MAX_LINES, MAX_SEGMENTS, MAX_TIME_MS, Segment};
use serde::Deserialize;
use std::io;

pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
struct Lyricsfile {
    version: String,
    metadata: Metadata,
    #[serde(default)]
    lines: Vec<FileLine>,
    plain: Option<String>,
}

#[derive(Deserialize)]
struct Metadata {
    title: String,
    artist: String,
    #[serde(default)]
    instrumental: bool,
    duration_ms: Option<u64>,
    offset_ms: Option<i64>,
    language: Option<String>,
}

#[derive(Deserialize)]
struct FileLine {
    text: String,
    start_ms: u64,
    end_ms: Option<u64>,
    #[serde(default)]
    words: Vec<FileWord>,
}

#[derive(Deserialize)]
struct FileWord {
    text: String,
    start_ms: u64,
    end_ms: Option<u64>,
}

pub fn lyricsfile(raw: &str, duration_ms: Option<u64>) -> Result<LyricsResponse, io::Error> {
    if raw.len() > MAX_RESPONSE_BYTES {
        return Err(io::Error::other("Lyricsfile is too large"));
    }
    let file: Lyricsfile = serde_yaml_ng::from_str(raw).map_err(io::Error::other)?;
    if file.version != "1.0"
        || file.metadata.title.trim().is_empty()
        || file.metadata.artist.trim().is_empty()
        || file.lines.len() > MAX_LINES
        || file
            .lines
            .iter()
            .map(|line| line.words.len().max(1))
            .sum::<usize>()
            > MAX_SEGMENTS
        || file
            .metadata
            .duration_ms
            .is_some_and(|value| value > MAX_TIME_MS)
        || file
            .metadata
            .offset_ms
            .is_some_and(|value| value.unsigned_abs() > MAX_TIME_MS)
    {
        return Err(io::Error::other("Unsupported or oversized Lyricsfile"));
    }
    // Lyricsfile 1.0 has no agreed offset semantics. Preserve timestamps without
    // applying its draft offset field; LRC offsets have defined semantics below.
    let mut result = LyricsResponse::empty(Some(file.metadata.instrumental));
    result.original_format = Some("lyricsfile");
    result.language = file.metadata.language;
    result.plain_lyrics = file.plain;
    if file.metadata.instrumental
        && (!file.lines.is_empty()
            || result
                .plain_lyrics
                .as_ref()
                .is_some_and(|text| !text.trim().is_empty()))
    {
        return Err(io::Error::other("Instrumental Lyricsfile contains lyrics"));
    }
    result.lines = file
        .lines
        .into_iter()
        .map(|line| LyricLine {
            text: line.text,
            start_ms: Some(line.start_ms),
            end_ms: line.end_ms,
            segments: line
                .words
                .into_iter()
                .map(|word| Segment::new(word.text, Some(word.start_ms), word.end_ms, "word"))
                .collect(),
            ..Default::default()
        })
        .collect();
    result.normalize(duration_ms.or(file.metadata.duration_ms));
    Ok(result)
}

pub fn timestamp_ms(value: &str) -> Option<u64> {
    let value = value.trim();
    let seconds = if value.contains(':') {
        let parts: Vec<_> = value.split(':').collect();
        if !(2..=3).contains(&parts.len()) {
            return None;
        }
        let seconds = parts.last()?.parse::<f64>().ok()?;
        if !(0.0..60.0).contains(&seconds) {
            return None;
        }
        let minutes = parts[parts.len() - 2].parse::<u64>().ok()?;
        if parts.len() == 3 {
            if minutes >= 60 {
                return None;
            }
            parts[0].parse::<u64>().ok()? as f64 * 3600.0 + minutes as f64 * 60.0 + seconds
        } else {
            minutes as f64 * 60.0 + seconds
        }
    } else if let Some(value) = value.strip_suffix("ms") {
        value.parse::<f64>().ok()? / 1000.0
    } else if let Some(value) = value.strip_suffix('h') {
        value.parse::<f64>().ok()? * 3600.0
    } else if let Some(value) = value.strip_suffix('m') {
        value.parse::<f64>().ok()? * 60.0
    } else {
        value
            .strip_suffix('s')
            .unwrap_or(value)
            .parse::<f64>()
            .ok()?
    };
    (seconds.is_finite() && (0.0..=MAX_TIME_MS as f64 / 1000.0).contains(&seconds))
        .then(|| (seconds * 1000.0).round() as u64)
}

pub fn lrc(raw: &str, duration_ms: Option<u64>) -> Result<LyricsResponse, io::Error> {
    if raw.len() > MAX_RESPONSE_BYTES {
        return Err(io::Error::other("LRC is too large"));
    }
    let mut result = LyricsResponse::empty(Some(false));
    result.original_format = Some("lrc");
    result.offset_ms = raw
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("[offset:")
                .and_then(|value| value.strip_suffix(']'))
                .and_then(|value| value.trim().parse::<i64>().ok())
        })
        .unwrap_or(0);
    if result.offset_ms.unsigned_abs() > MAX_TIME_MS {
        return Err(io::Error::other("Invalid LRC offset"));
    }
    for raw_line in raw.lines() {
        let mut remaining = raw_line.trim();
        let mut starts = Vec::new();
        while let Some(value) = remaining.strip_prefix('[') {
            let Some((tag, rest)) = value.split_once(']') else {
                break;
            };
            let Some(start) = tag.contains(':').then(|| timestamp_ms(tag)).flatten() else {
                break;
            };
            starts.push(start);
            remaining = rest;
        }
        for start in starts {
            let segments = enhanced_lrc(remaining.trim(), start);
            let text = segments
                .iter()
                .map(|segment| segment.text.as_str())
                .collect();
            result.lines.push(LyricLine {
                text,
                start_ms: Some(start),
                segments,
                ..Default::default()
            });
        }
        if result.lines.len() > MAX_LINES {
            return Err(io::Error::other("Too many lyric lines"));
        }
    }
    if result
        .lines
        .iter()
        .map(|line| line.segments.len())
        .sum::<usize>()
        > MAX_SEGMENTS
    {
        return Err(io::Error::other("Too many lyric segments"));
    }
    result.normalize(duration_ms);
    Ok(result)
}

fn enhanced_lrc(raw: &str, line_start: u64) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut remaining = raw;
    let mut start = line_start;
    while let Some(open) = remaining.find('<') {
        let Some(close) = remaining[open..].find('>').map(|close| close + open) else {
            break;
        };
        let tag = &remaining[open + 1..close];
        let Some(next) = tag.contains(':').then(|| timestamp_ms(tag)).flatten() else {
            break;
        };
        if open > 0 {
            segments.push(Segment::new(
                remaining[..open].to_owned(),
                Some(start),
                Some(next),
                "word",
            ));
        }
        start = next;
        remaining = &remaining[close + 1..];
    }
    if !remaining.is_empty() {
        segments.push(Segment::new(
            remaining.to_owned(),
            Some(start),
            None,
            if segments.is_empty() && remaining == raw {
                "line"
            } else {
                "word"
            },
        ));
    }
    segments
}
