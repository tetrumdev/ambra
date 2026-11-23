//! Line endings placed by the recording's isolated vocals (`crate::vocal_timing`). Where a
//! line's final word had no end timed by a person, the word ends where the singing stops,
//! never past the next line.
use super::model::{
    LyricLine, LyricsResponse, Segment, fit_line_end, has_detail, letters, next_word_start, sung_ends,
};
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
/// Inside a line, only silence this long (400 ms) is a pause after a word, not a consonant.
const PAUSE_FRAMES: i64 = 20;
/// A word given less time than this, up to the next word, has no room for a pause after it.
const MIN_PAUSED_WORD_MS: u64 = 700;
/// A pause this soon (300 ms) after a word's timed start is a pause before the word: its
/// timestamp caught the previous word's last sound, and it is sung once the singing resumes.
const LATE_START_FRAMES: i64 = 15;
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
    let at = |frame: i64| ((frame * FRAME_MS + shift) as f64 + offset_ms).max(0.0) as u64;
    // Where one line's last word runs straight into the next line's first word, sources often
    // start the first word while the last is still sung, or squeeze the last word to nothing
    // (moved by the song's pace in `normalize`). A gap in the singing just after the boundary
    // is where the line really changes. A gap later than that is a pause after the first word.
    for index in 1..lyrics.lines.len() {
        let (before, after) = lyrics.lines.split_at_mut(index);
        let (previous, line) = (&mut before[index - 1], &mut after[0]);
        let (Some((_, last)), Some((first, _))) = (sung_ends(previous), sung_ends(line)) else { continue };
        let (Some(last_start), Some(last_end), Some(first_start), Some(latest)) = (
            previous.segments[last].start_ms,
            previous.segments[last].end_ms,
            line.segments[first].start_ms,
            next_word_start(line, first),
        ) else {
            continue;
        };
        let shared = previous.segments[last].end_estimated && last_end.abs_diff(first_start) <= 50;
        if !(line.segments[first].start_estimated || shared) || previous.singer != line.singer {
            continue;
        }
        let from = frame_of(last_start as f64 - offset_ms) + MIN_WORD_MS / FRAME_MS;
        let to = frame_of(latest as f64 - offset_ms).min(frames) - MIN_WORD_MS / FRAME_MS;
        // Sources start these lines early, never late, so a gap the first word would have to
        // start before its timed start is a dip inside the last word.
        let first_frame = frame_of(first_start as f64 - offset_ms);
        let earliest = if line.segments[first].start_estimated { from } else { first_frame };
        let boundary = (from..to.min(first_frame + LATE_START_FRAMES))
            .filter(|frame| (*frame..frame + SILENT_FRAMES).all(|frame| !loud(frame)))
            .find_map(|gap| {
                let resumes = (gap + SILENT_FRAMES..to).find(|frame| loud(*frame))?;
                (resumes >= earliest).then_some((gap, resumes))
            });
        if let Some((gap, resumes)) = boundary {
            let end = at(gap).clamp(last_start + MIN_WORD_MS as u64, latest);
            previous.segments[last].end_ms = Some(end);
            let start = at(resumes).clamp(end, latest.saturating_sub(MIN_WORD_MS as u64).max(end));
            line.segments[first].start_ms = Some(start);
            line.start_ms = Some(start);
        }
        previous.estimated_end_limit = line.start_ms;
        fit_line_end(previous);
        for line in [previous, line] {
            if !line.words.is_empty() {
                line.words = line.segments.clone();
            }
        }
    }
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
    // Words a source timed only by their starts run on to the next word, across any breath
    // between them; a word followed by a pause ends where its singing stops.
    for line in &mut lyrics.lines {
        if !has_detail(line) {
            continue;
        }
        let mut changed = false;
        for index in 0..line.segments.len().saturating_sub(1) {
            let segment = &line.segments[index];
            let (Some(start), Some(end)) = (segment.start_ms, segment.end_ms) else { continue };
            if !segment.end_estimated || letters(&segment.text) == 0 || end < start + MIN_PAUSED_WORD_MS {
                continue;
            }
            let first = frame_of(start as f64 - offset_ms);
            let next = frame_of(end as f64 - offset_ms).min(frames);
            if !(first..first + ONSET_FRAMES).any(loud) {
                continue;
            }
            let Some(silent_from) = (first + MIN_WORD_MS / FRAME_MS..next - PAUSE_FRAMES)
                .find(|frame| (*frame..frame + PAUSE_FRAMES).all(|frame| !loud(frame)))
            else {
                continue;
            };
            let at = |frame: i64| ((frame * FRAME_MS + shift) as f64 + offset_ms).max(0.0) as u64;
            let resumes = (silent_from + PAUSE_FRAMES..next).find(|frame| loud(*frame));
            let previous = index.checked_sub(1).filter(|previous| {
                let previous = &line.segments[*previous];
                previous.end_estimated && previous.end_ms == Some(start)
            });
            if let (Some(resumes), Some(previous)) = (resumes, previous)
                && silent_from - first < LATE_START_FRAMES
            {
                let previous_start = line.segments[previous].start_ms.unwrap_or(start);
                let pause = at(silent_from).clamp(previous_start + MIN_WORD_MS as u64, start);
                line.segments[previous].end_ms = Some(pause);
                line.segments[index].start_ms = Some(at(resumes).clamp(start, end - MIN_WORD_MS as u64));
            } else {
                line.segments[index].end_ms = Some(at(silent_from).clamp(start + MIN_WORD_MS as u64, end));
            }
            changed = true;
        }
        if changed && !line.words.is_empty() {
            line.words = line.segments.clone();
        }
    }
    if lyrics.has_word_sync {
        // Lines a word-timed song left timed only as a whole get their words placed across the
        // stretch where the vocals are heard, each word's share set by its letters.
        for line in &mut lyrics.lines {
            let Some(start) = line.start_ms.filter(|_| !has_detail(line)) else { continue };
            let limit = line.end_ms.unwrap_or(start + LINE_FALLBACK_MS).min(start + MAX_LINE_MS);
            let first = frame_of(start as f64 - offset_ms);
            let last_frame = frame_of(limit as f64 - offset_ms).min(frames);
            let Some(onset) = (first..(first + ONSET_FRAMES).min(last_frame)).find(|frame| loud(*frame)) else {
                continue;
            };
            // Breaths inside the line are skipped, not taken for its end; it ends with the last singing.
            let sung: Vec<i64> = (onset..last_frame).filter(|frame| loud(*frame)).collect();
            let silent_from = sung.last().map_or(last_frame, |frame| frame + 1);
            let words = split_words(&line.text);
            let weights: Vec<usize> = words.iter().map(|word| letters(word).max(1)).collect();
            let total: usize = weights.iter().sum();
            if sung.is_empty() || letters(&line.text) == 0 {
                continue;
            }
            let at = |frame: i64| ((frame * FRAME_MS + shift) as f64 + offset_ms).max(0.0) as u64;
            let end = at(silent_from).clamp(start + MIN_WORD_MS as u64, limit.max(start + MIN_WORD_MS as u64));
            let mut before = 0;
            let mut starts: Vec<u64> = weights
                .iter()
                .map(|weight| {
                    let frame = sung[(sung.len() * before / total).min(sung.len() - 1)];
                    before += weight;
                    at(frame).clamp(start, end)
                })
                .collect();
            // The line still begins where its timing says; only the words inside it move.
            starts[0] = start;
            let singer = line.segments.iter().find_map(|segment| segment.singer.clone());
            line.segments = words
                .into_iter()
                .enumerate()
                .map(|(index, word)| {
                    let word_start = starts[index].max(starts[..index].iter().copied().max().unwrap_or(start));
                    let word_end = starts.get(index + 1).copied().unwrap_or(end).max(word_start);
                    let mut segment = Segment::new(word, Some(word_start), Some(word_end), "word");
                    segment.singer = singer.clone();
                    segment
                })
                .collect();
            fit_line_end(line);
            line.words = if has_detail(line) { line.segments.clone() } else { Vec::new() };
        }
    }
    true
}

/// A line's text as words, each carrying the whitespace after it, so they join back to the text.
fn split_words(text: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    for character in text.chars() {
        match words.last_mut() {
            Some(word) if character.is_whitespace() || !word.ends_with(char::is_whitespace) || word.trim().is_empty() => {
                word.push(character)
            }
            _ => words.push(character.to_string()),
        }
    }
    words
}
