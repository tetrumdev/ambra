//! Estimates one constant shift between synced lyrics and a recording, and where its singing
//! stops, from a per-frame vocal energy curve. The desktop app measures that curve from
//! centre-panned vocal-band energy; a server with the vocal separation model measures it from
//! the isolated vocals. Both score it the same way, so their results mean the same thing.
use serde::{Deserialize, Serialize};

pub const FRAME_MS: i64 = 20;
const MAX_SHIFT_FRAMES: i64 = 10_000 / FRAME_MS;
pub const MAX_ANALYSIS_FRAMES: usize = 20 * 60 * 1000 / FRAME_MS as usize;
pub const MAX_WINDOWS: usize = 20_000;
/// Words separated by less than a breath belong to one sung phrase.
const PHRASE_GAP_MS: f64 = 250.0;
const MIN_PHRASES: usize = 8;
/// Removes loudness changes between song sections while keeping phrase-scale contrast.
const DETREND_FRAMES: usize = 7_500 / FRAME_MS as usize;
const ONSET_FRAMES: i64 = 300 / FRAME_MS;
/// Shifts within one second of the best one belong to the same peak.
const PEAK_FRAMES: i64 = 1_000 / FRAME_MS;
/// Vocal level is read through this much smoothing, so a breath or a gap between words isn't an ending.
const END_SMOOTHING_FRAMES: usize = 500 / FRAME_MS as usize;
/// The singing is taken to stop between a little before the last phrase starts and a little
/// after its timing ends; a final line is often timed as held through the whole outro.
const END_SEARCH_BEFORE_FRAMES: i64 = 5_000 / FRAME_MS;
const END_SEARCH_AFTER_FRAMES: i64 = 10_000 / FRAME_MS;
/// How long the sung level is read for, back from the last phrase.
const SUNG_FRAMES: i64 = 30_000 / FRAME_MS;
/// Where the instrumental level is read, after the last phrase.
const OUTRO_FROM_FRAMES: i64 = 5_000 / FRAME_MS;
const OUTRO_FRAMES: i64 = 30_000 / FRAME_MS;
/// Sung and instrumental levels closer than this (in natural-log power, about 2.6 dB) can't place an ending.
/// A dense outro in the vocal band can sit this close to the singing and still be told apart.
const MIN_END_CONTRAST: f64 = 0.6;
/// The sung level is read this far up its spread: lyric windows also cover breaths, gaps and
/// final lines timed lazily into the outro, which would otherwise drag it toward the instrumental.
const SUNG_QUANTILE: f64 = 0.75;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricWindow {
    pub start_ms: f64,
    pub end_ms: f64,
}

/// The evidence for the best shift. Whether it is trusted is decided by the app,
/// which tunes its thresholds from the listener's own corrections.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricOffset {
    /// Milliseconds to add to the lyric offset at the best match; absent when nothing could be scored.
    pub best_ms: Option<i64>,
    /// How far the best match stands above typical shifts, in robust deviations.
    pub prominence: f64,
    /// How far the best match leads the strongest rival peak; absent when there is no rival.
    pub margin: Option<f64>,
    /// Playback milliseconds where the singing stops; absent when the recording can't tell.
    pub vocal_end_ms: Option<i64>,
}

pub const UNCERTAIN: LyricOffset = LyricOffset {
    best_ms: None,
    prominence: 0.0,
    margin: None,
    vocal_end_ms: None,
};

/// Lyric windows merged into sung phrases, in frames on the expected audio timeline.
pub fn phrases(windows: &[LyricWindow]) -> Vec<(i64, i64)> {
    let mut windows: Vec<(f64, f64)> = windows
        .iter()
        .filter(|window| window.start_ms.is_finite() && window.end_ms.is_finite())
        .map(|window| (window.start_ms.max(0.0), window.end_ms.min(86_400_000.0)))
        .filter(|(start, end)| end > start)
        .collect();
    windows.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (start, end) in windows {
        match merged.last_mut() {
            Some(last) if start <= last.1 + PHRASE_GAP_MS => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
        .into_iter()
        .map(|(start, end)| {
            let frame = |ms: f64| (ms / FRAME_MS as f64).round() as i64;
            (frame(start), frame(end))
        })
        .filter(|(start, end)| end > start)
        .collect()
}

/// A vocal energy curve, read two ways.
pub struct Envelope {
    /// Log energy of the vocals per frame.
    pub level: Vec<f64>,
    /// The same, detrended and standardized, for matching phrases.
    pub standardized: Vec<f64>,
}

/// Turns vocal power per `FRAME_MS` frame into the curves the matching reads.
pub fn envelope(power: Vec<f64>) -> Result<Envelope, String> {
    if power.len() < 2 * DETREND_FRAMES {
        return Err("The recording is too short to analyze".to_owned());
    }

    // Silence would dominate a plain log; floor it at the quiet end of the track.
    let mut sorted = power.clone();
    sorted.sort_by(f64::total_cmp);
    let floor = sorted[sorted.len() / 20].max(1e-12);
    let log: Vec<f64> = power.iter().map(|value| (value + floor).ln()).collect();
    let prefix = prefix_sums(&log);
    let detrended: Vec<f64> = (0..log.len())
        .map(|i| {
            let from = i.saturating_sub(DETREND_FRAMES);
            let to = (i + DETREND_FRAMES + 1).min(log.len());
            log[i] - (prefix[to] - prefix[from]) / (to - from) as f64
        })
        .collect();
    let deviation = (detrended.iter().map(|value| value * value).sum::<f64>()
        / detrended.len() as f64)
        .sqrt()
        .max(1e-9);
    Ok(Envelope {
        standardized: detrended
            .into_iter()
            .map(|value| value / deviation)
            .collect(),
        level: log,
    })
}

/// The best shift for these lyric windows against a recording's vocal power, and where its
/// singing stops. `label` names the song in diagnostics.
pub fn analyze(power: Vec<f64>, windows: &[LyricWindow], label: &str) -> Result<LyricOffset, String> {
    let phrases = phrases(windows);
    if phrases.is_empty() {
        return Ok(UNCERTAIN);
    }
    let envelope = envelope(power)?;
    // Lines timed back to back merge into a few long phrases, too few to place a shift,
    // but the ending can still be heard; lazily timed final lines are the ones that need it.
    let mut offset = if phrases.len() < MIN_PHRASES {
        eprintln!("[lyric-sync] {label}: uncertain, {} phrases (need {MIN_PHRASES})", phrases.len());
        UNCERTAIN
    } else {
        best_offset(&envelope.standardized, &phrases, label)
    };
    // An untrusted shift still places the ending better than none, and the app checks
    // the result against the lyrics it applies.
    let shift = offset.best_ms.unwrap_or(0) / FRAME_MS;
    offset.vocal_end_ms = vocal_end(&envelope.level, &phrases, shift).map(|frame| frame * FRAME_MS);
    Ok(offset)
}

/// The frame where the singing stops: the last time, around the final phrase, that the
/// smoothed vocal level is nearer the sung level than the instrumental one that follows.
fn vocal_end(level: &[f64], phrases: &[(i64, i64)], shift: i64) -> Option<i64> {
    let frames = level.len() as i64;
    let prefix = prefix_sums(level);
    let smoothed = |frame: i64| {
        let half = END_SMOOTHING_FRAMES as i64 / 2;
        let (from, to) = ((frame - half).max(0), (frame + half + 1).min(frames));
        (prefix[to as usize] - prefix[from as usize]) / (to - from).max(1) as f64
    };
    let quantile = |mut values: Vec<f64>, quantile: f64| {
        values.sort_by(f64::total_cmp);
        values
            .get(((values.len() as f64 * quantile) as usize).min(values.len().saturating_sub(1)))
            .copied()
    };
    let (last_start, last) = phrases
        .iter()
        .map(|&(start, end)| (start - shift, end - shift))
        .max_by_key(|&(_, end)| end)?;
    if last <= 0 || last >= frames {
        return None;
    }
    let sung = quantile(
        phrases
            .iter()
            .map(|&(start, end)| {
                (
                    (start - shift).max(last - SUNG_FRAMES).max(0),
                    (end - shift).min(frames),
                )
            })
            .flat_map(|(start, end)| start..end)
            .map(smoothed)
            .collect(),
        SUNG_QUANTILE,
    )?;
    let outro_start = last + OUTRO_FROM_FRAMES;
    let outro_end = (outro_start + OUTRO_FRAMES).min(frames);
    if outro_end - outro_start < OUTRO_FROM_FRAMES {
        return None;
    }
    let outro = quantile((outro_start..outro_end).map(smoothed).collect(), 0.5)?;
    if sung - outro < MIN_END_CONTRAST {
        return None;
    }
    let threshold = outro + (sung - outro) / 2.0;
    ((last_start - END_SEARCH_BEFORE_FRAMES).max(0)..(last + END_SEARCH_AFTER_FRAMES).min(frames))
        .rev()
        .find(|&frame| smoothed(frame) > threshold)
}

pub fn prefix_sums(values: &[f64]) -> Vec<f64> {
    let mut prefix = Vec::with_capacity(values.len() + 1);
    prefix.push(0.0);
    for value in values {
        prefix.push(prefix.last().unwrap() + value);
    }
    prefix
}

/// Scores every shift by phrase/gap energy contrast plus energy rises at phrase starts.
fn best_offset(envelope: &[f64], phrases: &[(i64, i64)], label: &str) -> LyricOffset {
    let frames = envelope.len() as i64;
    let prefix = prefix_sums(envelope);
    let sum = |from: i64, to: i64| {
        let (from, to) = (from.clamp(0, frames), to.clamp(0, frames));
        (
            prefix[to as usize] - prefix[from as usize],
            (to - from).max(0),
        )
    };
    let total = prefix[frames as usize];
    let shifts: Vec<i64> = (-MAX_SHIFT_FRAMES..=MAX_SHIFT_FRAMES).collect();
    let mut contrast = Vec::with_capacity(shifts.len());
    let mut onsets = Vec::with_capacity(shifts.len());
    for &shift in &shifts {
        // A positive correction means each phrase is sung earlier than its timing says.
        let (mut inside, mut count) = (0.0, 0);
        let (mut rise, mut rises) = (0.0, 0);
        for &(start, end) in phrases {
            let (value, length) = sum(start - shift, end - shift);
            inside += value;
            count += length;
            let onset = start - shift;
            if onset - ONSET_FRAMES >= 0 && onset + ONSET_FRAMES <= frames {
                rise += sum(onset, onset + ONSET_FRAMES).0 - sum(onset - ONSET_FRAMES, onset).0;
                rises += 1;
            }
        }
        if count < PEAK_FRAMES || frames - count < PEAK_FRAMES || rises < MIN_PHRASES {
            eprintln!(
                "[lyric-sync] {label}: uncertain at shift {} ms, sung {count}/{frames} frames, {rises} onsets",
                shift * FRAME_MS,
            );
            return UNCERTAIN;
        }
        contrast.push(inside / count as f64 - (total - inside) / (frames - count) as f64);
        onsets.push(rise / (rises as f64 * ONSET_FRAMES as f64));
    }
    let standardize = |values: &mut Vec<f64>| {
        let mean = values.iter().sum::<f64>() / values.len() as f64;
        let deviation = (values
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / values.len() as f64)
            .sqrt()
            .max(1e-9);
        for value in values.iter_mut() {
            *value = (*value - mean) / deviation;
        }
    };
    standardize(&mut contrast);
    standardize(&mut onsets);
    let scores: Vec<f64> = contrast.iter().zip(&onsets).map(|(a, b)| a + b).collect();

    let best = (0..scores.len())
        .max_by(|&a, &b| scores[a].total_cmp(&scores[b]))
        .unwrap();
    let away = |index: usize| (index as i64 - best as i64).abs() > PEAK_FRAMES;
    let mut background: Vec<f64> = (0..scores.len())
        .filter(|&i| away(i))
        .map(|i| scores[i])
        .collect();
    if background.is_empty() {
        return UNCERTAIN;
    }
    background.sort_by(f64::total_cmp);
    let median = background[background.len() / 2];
    let mut deviations: Vec<f64> = background
        .iter()
        .map(|value| (value - median).abs())
        .collect();
    deviations.sort_by(f64::total_cmp);
    let noise = (1.4826 * deviations[deviations.len() / 2]).max(1e-9);
    // Repeating song structure can produce a rival peak, typically a bar or phrase away.
    let rival = (0..scores.len())
        .filter(|&i| away(i))
        .filter(|&i| {
            let from = i.saturating_sub(12);
            let to = (i + 13).min(scores.len());
            scores[from..to].iter().all(|value| *value <= scores[i])
        })
        .map(|i| scores[i])
        .fold(f64::NEG_INFINITY, f64::max);
    let prominence = (scores[best] - median) / noise;
    let margin = (rival != f64::NEG_INFINITY).then(|| (scores[best] - rival) / noise);
    let rival_shift = (0..scores.len())
        .filter(|&i| away(i) && scores[i] == rival)
        .map(|i| shifts[i] * FRAME_MS)
        .next();
    eprintln!(
        "[lyric-sync] {label}: best {} ms, prominence {prominence:.2}, rival {} margin {}, {} phrases",
        shifts[best] * FRAME_MS,
        rival_shift.map_or("none".to_owned(), |shift| format!("{shift} ms")),
        margin.map_or("none".to_owned(), |margin| format!("{margin:.2}")),
        phrases.len(),
    );
    LyricOffset {
        best_ms: Some(shifts[best] * FRAME_MS),
        prominence,
        margin,
        vocal_end_ms: None,
    }
}

