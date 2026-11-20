//! Line endings placed by the recording's isolated vocals (`crate::vocal_timing`). Where a
//! line's final word had no end timed by a person, the word ends where the singing stops,
//! never past the next line.
use super::model::{LyricLine, LyricsResponse, fit_line_end, has_detail, letters};
use ambra_lyric_sync::{FRAME_MS, LyricWindow};

/// Line-only timings rarely carry ends; a line is assumed sung for at most this long.
const LINE_FALLBACK_MS: u64 = 6_000;
const MAX_LINE_MS: u64 = 15_000;
/// The app's default trust in a shift (lyricsAutoTuning.ts); below it, the timing is read as is.
const MIN_PROMINENCE: f64 = 4.0;
const MIN_MARGIN: f64 = 0.75;
/// Vocal level is read through 100 ms of smoothing: enough to bridge a consonant, not a breath.
const SMOOTHING_FRAMES: i64 = 5;
/// The singing has stopped once the level stays low this long (160 ms).
const SILENT_FRAMES: i64 = 8;
const MIN_WORD_MS: i64 = 120;
/// The word must be heard within this long of its start, or the vocals can't place its end.
const ONSET_FRAMES: i64 = 400 / FRAME_MS;
/// Sung and gap levels closer than this (natural-log power) can't tell singing from silence.
const MIN_CONTRAST: f64 = 0.6;

/// Sung intervals on the audio timeline the lyrics assume, as the app measures them.
fn windows(lyrics: &LyricsResponse) -> Vec<LyricWindow> {
    let mut windows = Vec::new();
    let offset = lyrics.offset_ms as f64;
    let mut add = |line: &LyricLine, next_start: Option<u64>| {
        let Some(start) = line.start_ms.filter(|_| !line.text.trim().is_empty()) else { return };
        let timed: Vec<(u64, u64)> = line
            .segments
            .iter()
            .filter(|segment| !segment.text.trim().is_empty())
            .filter_map(|segment| segment.start_ms.zip(segment.end_ms))
            .filter(|(start, end)| end > start)
            .collect();
        let spans = if timed.len() > 1 {
            timed
        } else {
            let end = line
                .end_ms
                .unwrap_or_else(|| next_start.unwrap_or(u64::MAX).min(start + LINE_FALLBACK_MS))
                .min(start + MAX_LINE_MS);
            vec![(start, end)]
        };
        for (start, end) in spans.into_iter().filter(|(start, end)| end > start) {
            windows.push(LyricWindow { start_ms: start as f64 - offset, end_ms: end as f64 - offset });
        }
    };
    for (index, line) in lyrics.lines.iter().enumerate() {
        let next_start = line.start_ms.and_then(|start| {
            lyrics.lines[index + 1..].iter().filter_map(|next| next.start_ms).find(|next| *next > start)
        });
        add(line, next_start);
        for background in &line.background_vocals {
            add(background, next_start);
        }
    }
    windows
}

/// Places estimated line endings where the isolated vocals (`power`, per `FRAME_MS` frame)
/// stop. Returns false when the recording can't be read against these lyrics.
pub fn refine(lyrics: &mut LyricsResponse, power: &[f64]) -> bool {
    let windows = windows(lyrics);
    let Ok(offset) = ambra_lyric_sync::analyze(power.to_vec(), &windows, "vocal-timing") else {
        return false;
    };
    let Ok(envelope) = ambra_lyric_sync::envelope(power.to_vec()) else { return false };
    let trusted = offset.prominence >= MIN_PROMINENCE && offset.margin.is_none_or(|margin| margin >= MIN_MARGIN);
    // Lyric time T is sung at playback time T - offset_ms - shift.
    let shift = if trusted { offset.best_ms.unwrap_or(0) } else { 0 };
    let level = &envelope.level;
    let frames = level.len() as i64;
    let prefix = ambra_lyric_sync::prefix_sums(level);
    let smoothed = |frame: i64| {
        let half = SMOOTHING_FRAMES / 2;
        let (from, to) = ((frame - half).clamp(0, frames), (frame + half + 1).clamp(0, frames));
        (to > from).then(|| (prefix[to as usize] - prefix[from as usize]) / (to - from) as f64)
    };
    let frame_of = |ms: f64| ((ms - shift as f64) / FRAME_MS as f64).round() as i64;

    let mut sung_frame = vec![false; level.len()];
    for window in &windows {
        for frame in frame_of(window.start_ms).max(0)..frame_of(window.end_ms).min(frames) {
            sung_frame[frame as usize] = true;
        }
    }
    let quantile = |mut values: Vec<f64>, quantile: f64| {
        values.sort_by(f64::total_cmp);
        values.get((values.len() as f64 * quantile) as usize).copied()
    };
    let in_windows = (0..frames).filter(|frame| sung_frame[*frame as usize]);
    let (Some(sung), Some(gap)) = (
        quantile(in_windows.filter_map(smoothed).collect(), 0.75),
        // Lazily timed lyrics leave singing outside their windows, so the quiet end of the whole
        // recording stands for the silence between phrases.
        quantile((0..frames).filter_map(smoothed).collect(), 0.25),
    ) else {
        return false;
    };
    if sung - gap < MIN_CONTRAST {
        return false;
    }
    let threshold = gap + (sung - gap) / 2.0;
    let loud = |frame: i64| smoothed(frame).is_some_and(|value| value > threshold);

    let offset_ms = lyrics.offset_ms as f64;
    for line in &mut lyrics.lines {
        let Some(limit) = line.estimated_end_limit.filter(|_| has_detail(line)) else { continue };
        let Some(last) = line
            .segments
            .iter()
            .rposition(|segment| segment.start_ms.is_some() && letters(&segment.text) > 0)
        else {
            continue;
        };
        let Some(start) = line.segments[last].start_ms else { continue };
        let first = frame_of(start as f64 - offset_ms);
        let last_frame = frame_of(limit as f64 - offset_ms).min(frames);
        if !(first..first + ONSET_FRAMES).any(loud) {
            continue;
        }
        let silent_from = (first + MIN_WORD_MS / FRAME_MS..last_frame)
            .find(|frame| (*frame..frame + SILENT_FRAMES).all(|frame| !loud(frame)));
        let end = match silent_from {
            Some(frame) => ((frame * FRAME_MS + shift) as f64 + offset_ms).max(0.0) as u64,
            None => limit,
        };
        line.segments[last].end_ms = Some(end.clamp(start + MIN_WORD_MS as u64, limit.max(start + MIN_WORD_MS as u64)));
        fit_line_end(line);
        if !line.words.is_empty() {
            line.words = line.segments.clone();
        }
    }
    true
}
