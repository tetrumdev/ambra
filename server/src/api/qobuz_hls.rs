//! Qobuz songs as HLS for the phone (`ambra_net::flac_hls`): Apple's player can't seek inside
//! a FLAC file, so it plays `playlist.m3u8`, `dash/init` and `dash/{n}` instead of `stream`,
//! the same routes Tidal's segmented songs use. Each segment is whole FLAC frames, read from
//! the same bytes `stream` serves.

use std::{
    collections::HashMap,
    ops::Range,
    sync::{Arc, Mutex},
};

use ambra_net::flac_hls::{self, Header, Scan, Segment};
use axum::{
    body::Body,
    http::{
        HeaderValue, StatusCode,
        header::{ACCEPT_ENCODING, CACHE_CONTROL, CONTENT_RANGE, CONTENT_TYPE, RANGE},
    },
    response::Response,
};
use futures_util::TryStreamExt;

use super::{ApiError, AppState, qobuz_provider};
use crate::providers::qobuz::PlaybackLocation;

/// How a song's file was cut into segments, kept so each segment doesn't read the header again.
#[derive(Clone)]
struct Plan {
    header: Header,
    segments: Arc<Vec<Segment>>,
}

static PLANS: Mutex<Option<HashMap<String, Plan>>> = Mutex::new(None);
/// Plans kept at once; a song's is cheap to work out again.
const PLANS_KEPT: usize = 64;

/// Reads byte ranges of the FLAC file `stream` serves for a track.
struct File {
    location: PlaybackLocation,
    http: reqwest::Client,
}

impl File {
    async fn open(state: &AppState, track_id: &str) -> Result<Self, ApiError> {
        let provider = qobuz_provider(state)?;
        let source = provider.playback_source(track_id).await.map_err(ApiError::upstream)?;
        Ok(Self { location: source.location, http: state.download_http_client.clone() })
    }

    /// The bytes in `range`, and the file's whole length.
    async fn read(&self, range: Range<u64>) -> Result<(Vec<u8>, u64), ApiError> {
        match &self.location {
            PlaybackLocation::Cmaf(source) => {
                let length = source.content_length();
                let range = range.start.min(length)..range.end.min(length);
                let bytes: Vec<bytes::Bytes> = source.clone().bytes(range).try_collect().await.map_err(ApiError::upstream)?;
                Ok((bytes.concat(), length))
            }
            PlaybackLocation::Direct(url) => {
                let response = self.http.get(url).header(ACCEPT_ENCODING, "identity")
                    .header(RANGE, format!("bytes={}-{}", range.start, range.end.saturating_sub(1)))
                    .send().await.map_err(|error| ApiError::upstream(error.without_url()))?;
                let length = response.headers().get(CONTENT_RANGE).and_then(|value| value.to_str().ok())
                    .and_then(|value| value.rsplit('/').next()).and_then(|total| total.parse().ok())
                    .or_else(|| response.content_length())
                    .ok_or_else(|| ApiError::upstream("Qobuz didn't say how long the song is"))?;
                let partial = response.status() == StatusCode::PARTIAL_CONTENT;
                let bytes = response.bytes().await.map_err(|error| ApiError::upstream(error.without_url()))?;
                // A server that ignores the range sends the whole file.
                let bytes = if partial { bytes.to_vec() } else { bytes.get(range.start as usize..(range.end as usize).min(bytes.len())).unwrap_or_default().to_vec() };
                Ok((bytes, length))
            }
        }
    }
}

async fn plan(state: &AppState, track_id: &str) -> Result<(File, Plan), ApiError> {
    let file = File::open(state, track_id).await?;
    if let Some(plan) = PLANS.lock().ok().and_then(|plans| plans.as_ref()?.get(track_id).cloned()) {
        return Ok((file, plan));
    }
    let (mut head, length) = file.read(0..64 * 1024).await?;
    let header = loop {
        match flac_hls::parse_header(&head) {
            Ok(header) => break header,
            Err(Some(needed)) if needed as u64 <= length && needed > head.len() => head = file.read(0..needed as u64).await?.0,
            Err(_) => return Err(ApiError::not_found(format!("Qobuz track {track_id} isn't FLAC this player can segment"))),
        }
    };
    let segments = match header.segments(length) {
        Some(segments) => segments,
        None => {
            // shortcut: a file without a seek table is read through once (all of it) before it plays; fine for Qobuz's
            // CMAF songs, which always have one (cmaf.rs), and rare otherwise.
            let mut scan = Scan::new(&header, length);
            while !scan.done() {
                let from = scan.wanted();
                let (bytes, _) = file.read(from..from + 4 * flac_hls::MAX_FRAME as u64).await?;
                if !scan.feed(&bytes) {
                    return Err(ApiError::internal(format!("Qobuz track {track_id}'s FLAC frames couldn't be followed")));
                }
            }
            scan.segments().ok_or_else(|| ApiError::internal(format!("Qobuz track {track_id} has no segments")))?
        }
    };
    let plan = Plan { header, segments: Arc::new(segments) };
    if let Ok(mut plans) = PLANS.lock() {
        let plans = plans.get_or_insert_with(HashMap::new);
        if plans.len() >= PLANS_KEPT {
            plans.clear();
        }
        plans.insert(track_id.to_owned(), plan.clone());
    }
    Ok((file, plan))
}

fn respond(content_type: &'static str, body: Vec<u8>) -> Result<Response, ApiError> {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, HeaderValue::from_static(content_type))
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .map_err(ApiError::internal)
}

pub async fn playlist(state: &AppState, track_id: &str, query: &str) -> Result<Response, ApiError> {
    let (_, plan) = plan(state, track_id).await?;
    respond("application/vnd.apple.mpegurl", flac_hls::playlist(&plan.segments, plan.header.sample_rate, query).into_bytes())
}

pub async fn initialization(state: &AppState, track_id: &str) -> Result<Response, ApiError> {
    let (_, plan) = plan(state, track_id).await?;
    respond("audio/mp4", flac_hls::init_segment(&plan.header))
}

pub async fn segment(state: &AppState, track_id: &str, index: u32) -> Result<Response, ApiError> {
    let (file, plan) = plan(state, track_id).await?;
    let segment = *plan.segments.get(index as usize).ok_or_else(|| ApiError::not_found(format!("Segment {index} is outside this song")))?;
    let (bytes, _) = file.read(segment.start..segment.end).await?;
    let media = flac_hls::media_segment(&plan.header, index as usize, &segment, &bytes)
        .ok_or_else(|| ApiError::internal(format!("Qobuz track {track_id}'s segment {index} isn't whole FLAC frames")))?;
    respond("audio/mp4", media)
}
