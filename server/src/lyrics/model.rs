use serde::Serialize;

pub const MAX_TIME_MS: u64 = 86_400_000;
pub const MAX_LINES: usize = 5000;
pub const MAX_SEGMENTS: usize = 30_000;
/// Bounds on how long a final line without an end of its own stays highlighted.
const FINAL_LINE_MIN_MS: u64 = 4_000;
const FINAL_LINE_MAX_MS: u64 = 15_000;
/// Singing pace assumed when a song has too few timed words to measure its own.
const DEFAULT_MS_PER_LETTER: f64 = 85.0;
const MIN_PACE_SAMPLES: usize = 8;
/// A word starting this long after the previous word of its line is a timing error in the source.
const MAX_WORD_GAP_MS: u64 = 15_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub text: String,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub granularity: &'static str,
    pub singer: Option<String>,
    /// The end was filled in from the next word's start, so it may run over a pause after the word.
    #[serde(skip)]
    pub end_estimated: bool,
    /// The start was moved off a line boundary the source timed too early (`move_squeezed_boundaries`).
    #[serde(skip)]
    pub start_estimated: bool,
}

impl Segment {
    pub fn new(
        text: String,
        start_ms: Option<u64>,
        end_ms: Option<u64>,
        granularity: &'static str,
    ) -> Self {
        Self {
            text,
            start_ms,
            end_ms,
            granularity,
            singer: None,
            end_estimated: false,
            start_estimated: false,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub language: Option<String>,
    pub segments: Vec<Segment>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub text: String,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub segments: Vec<Segment>,
    /// Compatibility for older Ambra clients. The engine uses `segments` exclusively.
    pub words: Vec<Segment>,
    pub singer: Option<String>,
    pub translations: Vec<Annotation>,
    pub romanization: Vec<Annotation>,
    pub background_vocals: Vec<LyricLine>,
    pub key: Option<String>,
    /// For a line whose final word's end was estimated rather than timed by a person: the
    /// latest it may end (the next line). The recording's vocals can then place it exactly.
    #[serde(skip)]
    pub estimated_end_limit: Option<u64>,
}

#[derive(Clone, Serialize)]
pub struct Singer {
    pub id: String,
    pub name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResponse {
    pub status: &'static str,
    pub instrumental: Option<bool>,
    pub sync: &'static str,
    pub has_word_sync: bool,
    pub plain_lyrics: Option<String>,
    pub lines: Vec<LyricLine>,
    pub source: Option<&'static str>,
    pub original_format: Option<&'static str>,
    /// Added to playback time. Positive values advance highlighting.
    pub offset_ms: i64,
    pub language: Option<String>,
    pub singers: Vec<Singer>,
    pub failed_providers: Vec<&'static str>,
    /// `aligned` once the recording's isolated vocals placed line endings, `pending` while
    /// the server is still analyzing it; absent when vocal timing is off or unavailable.
    pub vocal_timing: Option<&'static str>,
    /// Word timing placed by a model (TTML `byModel`), whose line endings are often wrong.
    pub machine_timed: bool,
}

impl LyricsResponse {
    pub fn empty(instrumental: Option<bool>) -> Self {
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
            source: None,
            original_format: None,
            offset_ms: 0,
            language: None,
            singers: Vec::new(),
            failed_providers: Vec::new(),
            vocal_timing: None,
            machine_timed: false,
        }
    }

    pub fn normalize(&mut self, duration_ms: Option<u64>) {
        self.plain_lyrics = self
            .plain_lyrics
            .take()
            .filter(|text| !text.trim().is_empty() && text.lines().count() <= MAX_LINES);
        self.lines
            .retain(|line| valid_range(line.start_ms, line.end_ms));
        let song_ms_per_letter = ms_per_letter(&self.lines);
        for line in &mut self.lines {
            pull_in_stray_words(line, song_ms_per_letter);
        }
        self.lines.sort_by_key(|line| line.start_ms);
        // A final line without an end would otherwise run to the end of the track, holding it
        // over a long instrumental ending; it is held about twice the song's typical line instead.
        let mut starts: Vec<u64> = self.lines.iter().filter_map(|line| line.start_ms).collect();
        starts.dedup();
        let mut gaps: Vec<u64> = starts.windows(2).map(|pair| pair[1] - pair[0]).collect();
        gaps.sort_unstable();
        let final_hold = gaps.get(gaps.len() / 2).map_or(FINAL_LINE_MAX_MS, |median| {
            (median * 2).clamp(FINAL_LINE_MIN_MS, FINAL_LINE_MAX_MS)
        });
        let pace = Pace {
            ms_per_letter: song_ms_per_letter,
            machine_timed: self.machine_timed,
        };
        let mut next = duration_ms;
        for (index, group) in self
            .lines
            .chunk_by_mut(|a, b| a.start_ms == b.start_ms)
            .rev()
            .enumerate()
        {
            let start = group[0].start_ms;
            let end = if index == 0 {
                next.map(|end| start.map_or(end, |start| end.min(start + final_hold)))
            } else {
                next
            };
            for line in group {
                normalize_line(line, end, Some(pace));
            }
            next = start.or(next);
        }
        move_squeezed_boundaries(&mut self.lines, pace.ms_per_letter);
        if self
            .lines
            .iter()
            .all(|line| line.text.trim().is_empty() && line.background_vocals.is_empty())
        {
            self.lines.clear();
        }
        if self.lines.is_empty() {
            if let Some(plain) = &self.plain_lyrics {
                self.lines = plain
                    .lines()
                    .map(|text| LyricLine {
                        text: text.to_owned(),
                        segments: vec![Segment::new(text.to_owned(), None, None, "none")],
                        ..Default::default()
                    })
                    .collect();
            }
        }
        let detailed: Vec<_> = self
            .lines
            .iter()
            .flat_map(|line| std::iter::once(line).chain(line.background_vocals.iter()))
            .filter(|line| has_detail(line))
            .collect();
        self.has_word_sync = !detailed.is_empty();
        self.sync = if self.has_word_sync {
            if detailed.iter().any(|line| {
                line.segments
                    .iter()
                    .any(|segment| segment.granularity == "syllable")
            }) {
                "syllable"
            } else if detailed.iter().any(|line| {
                line.segments
                    .iter()
                    .any(|segment| segment.granularity == "segment")
            }) {
                "segment"
            } else {
                "word"
            }
        } else if self.lines.iter().any(|line| line.start_ms.is_some()) {
            "line"
        } else {
            "none"
        };
        self.status = if self.lines.is_empty() && self.plain_lyrics.is_none() {
            if self.instrumental == Some(true) {
                "instrumental"
            } else {
                "unavailable"
            }
        } else {
            "lyrics"
        };
        if self.status == "lyrics" {
            self.instrumental = Some(false);
        }
    }
}

pub fn valid_range(start: Option<u64>, end: Option<u64>) -> bool {
    start.is_none_or(|value| value <= MAX_TIME_MS)
        && end.is_none_or(|value| value <= MAX_TIME_MS && start.is_none_or(|start| value >= start))
}

pub fn has_detail(line: &LyricLine) -> bool {
    let mut windows = line
        .segments
        .iter()
        .filter(|segment| {
            !segment.text.trim().is_empty()
                && segment
                    .end_ms
                    .zip(segment.start_ms)
                    .is_some_and(|(end, start)| end > start)
        })
        .filter_map(|segment| segment.start_ms.zip(segment.end_ms));
    let Some(first) = windows.next() else {
        return false;
    };
    windows.any(|window| window != first)
}

/// The song's own singing pace, so a line's final word can be checked against it.
#[derive(Clone, Copy)]
struct Pace {
    ms_per_letter: f64,
    machine_timed: bool,
}

/// Median time per letter across words that are followed by another word in their line,
/// whose timing the next word's start pins down. Line-final words are what gets repaired.
fn ms_per_letter(lines: &[LyricLine]) -> f64 {
    let mut samples: Vec<f64> = lines
        .iter()
        .flat_map(|line| line.segments.windows(2))
        .filter_map(|pair| {
            let start = pair[0].start_ms?;
            let end = pair[0].end_ms.or(pair[1].start_ms)?;
            let letters = letters(&pair[0].text);
            (letters > 0 && end > start && end - start < 3_000)
                .then(|| (end - start) as f64 / letters as f64)
        })
        .collect();
    if samples.len() < MIN_PACE_SAMPLES {
        return DEFAULT_MS_PER_LETTER;
    }
    let middle = samples.len() / 2;
    *samples.select_nth_unstable_by(middle, f64::total_cmp).1
}

pub(super) fn letters(text: &str) -> usize {
    text.chars().filter(|character| character.is_alphanumeric()).count()
}

/// A line's last word has no following word to bound it, so its end is the least reliable
/// timing in a line. When it was filled in from the next line (or the end of the track), it
/// can run on long after the word is sung; a model's alignment can also cut a held word off
/// almost at once. Either is brought back near what the song's pace says the word takes,
/// never past the next line. Word endings a person timed are left alone.
fn repair_final_word(line: &mut LyricLine, pace: Pace, end_inferred: bool, limit: Option<u64>) {
    let Some(last) = line
        .segments
        .iter()
        .rposition(|segment| segment.start_ms.is_some() && letters(&segment.text) > 0)
    else {
        return;
    };
    let segment = &line.segments[last];
    let word_letters = letters(&segment.text);
    let (Some(start), Some(end)) = (segment.start_ms, segment.end_ms) else {
        return;
    };
    if end_inferred || pace.machine_timed {
        line.estimated_end_limit = Some(limit.filter(|limit| *limit > start).unwrap_or(end.max(start + 15_000)));
    }
    let expected = (word_letters as f64 * pace.ms_per_letter).clamp(250.0, 2_000.0);
    let duration = end.saturating_sub(start) as f64;
    let target = if (end_inferred || pace.machine_timed) && duration > (expected * 3.0).max(1_500.0) {
        (expected * 2.0).clamp(600.0, 3_000.0)
    } else if pace.machine_timed && duration < expected * 0.5 {
        (expected * 1.5).clamp(300.0, 3_000.0)
    } else {
        return;
    };
    let mut repaired = start + target.round() as u64;
    if let Some(limit) = limit.filter(|limit| *limit > start) {
        repaired = repaired.min(limit);
    }
    line.segments[last].end_ms = Some(repaired);
    fit_line_end(line);
}

/// The first and last sung words of a line, as indices into its segments.
pub(super) fn sung_ends(line: &LyricLine) -> Option<(usize, usize)> {
    let sung = |segment: &Segment| segment.start_ms.is_some() && letters(&segment.text) > 0;
    Some((line.segments.iter().position(sung)?, line.segments.iter().rposition(sung)?))
}

/// When the next word after `index` starts, which bounds how late that word can begin.
pub(super) fn next_word_start(line: &LyricLine, index: usize) -> Option<u64> {
    line.segments[index + 1..].iter().find_map(|segment| segment.start_ms).or(line.end_ms)
}

fn expected_word_ms(segment: &Segment, ms_per_letter: f64) -> u64 {
    (letters(&segment.text) as f64 * ms_per_letter).clamp(250.0, 2_000.0).round() as u64
}

/// Some sources start each line's first word where the previous line's last word starts to
/// be sung, so that word flashes by and the next line's first word drags on through it. The
/// boundary between them is moved to where the song's pace says the last word ends, and
/// marked so the recording's vocals can place it exactly (`vocal::refine`).
fn move_squeezed_boundaries(lines: &mut [LyricLine], ms_per_letter: f64) {
    for index in 1..lines.len() {
        let (before, after) = lines.split_at_mut(index);
        let (previous, line) = (&mut before[index - 1], &mut after[0]);
        if previous.singer != line.singer || previous.start_ms >= line.start_ms {
            continue;
        }
        let (Some((_, last)), Some((first, _))) = (sung_ends(previous), sung_ends(line)) else { continue };
        let (Some(last_start), Some(last_end), Some(first_start), Some(first_end)) = (
            previous.segments[last].start_ms,
            previous.segments[last].end_ms,
            line.segments[first].start_ms,
            next_word_start(line, first),
        ) else {
            continue;
        };
        let last_expected = expected_word_ms(&previous.segments[last], ms_per_letter);
        let first_expected = expected_word_ms(&line.segments[first], ms_per_letter);
        if last_end.abs_diff(first_start) > 50
            || last_end.saturating_sub(last_start) * 2 >= last_expected
            || first_end.saturating_sub(first_start) <= first_expected * 2
            || line.segments[..first].iter().any(|segment| segment.start_ms.is_some())
        {
            continue;
        }
        let boundary = (last_start + last_expected).min(first_end - first_expected).max(first_start);
        previous.segments[last].end_ms = Some(boundary);
        previous.segments[last].end_estimated = true;
        previous.estimated_end_limit = Some(first_end.saturating_sub(first_expected / 2).max(boundary));
        fit_line_end(previous);
        line.segments[first].start_ms = Some(boundary);
        line.segments[first].start_estimated = true;
        line.start_ms = Some(boundary);
        for line in [previous, line] {
            line.words = if has_detail(line) { line.segments.clone() } else { Vec::new() };
        }
    }
}

/// Some sources time a word of a line minutes away from the rest of it, so the line would
/// sweep on through a long instrumental. The line is split where its words are that far apart;
/// the group with the most words keeps its timing (the earliest, on a tie) and the others are
/// moved up against it at the song's pace. A line end the source took from a stray word is
/// dropped, to be estimated like any missing end.
fn pull_in_stray_words(line: &mut LyricLine, ms_per_letter: f64) {
    let starts: Vec<(usize, u64)> = line
        .segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| segment.start_ms.map(|start| (index, start)))
        .collect();
    let mut groups: Vec<Vec<(usize, u64)>> = Vec::new();
    for &(index, start) in &starts {
        match groups.last_mut() {
            Some(group) if start <= group.last().unwrap().1 + MAX_WORD_GAP_MS => group.push((index, start)),
            _ => groups.push(vec![(index, start)]),
        }
    }
    if groups.len() < 2 {
        return;
    }
    let anchor = (0..groups.len())
        .max_by_key(|group| (groups[*group].len(), std::cmp::Reverse(*group)))
        .unwrap();
    // Each group moves with the untimed segments that follow it, up to the next group.
    let count = line.segments.len();
    let range = |group: usize| {
        let from = if group == 0 { 0 } else { groups[group][0].0 };
        from..groups.get(group + 1).map_or(count, |next| next[0].0)
    };
    let shift = |line: &mut LyricLine, group: usize, delta: i64| {
        let moved = |value: u64| value.saturating_add_signed(delta);
        for segment in &mut line.segments[range(group)] {
            segment.start_ms = segment.start_ms.map(moved);
            segment.end_ms = segment.end_ms.map(moved);
        }
    };
    let expected = |segment: &Segment| expected_word_ms(segment, ms_per_letter);
    let old_first = starts[0].1;
    let old_last = starts.last().unwrap().1;
    for group in anchor + 1..groups.len() {
        let previous = &line.segments[groups[group - 1].last().unwrap().0];
        let previous_start = previous.start_ms.unwrap();
        let first_start = line.segments[groups[group][0].0].start_ms.unwrap();
        let target = previous
            .end_ms
            .filter(|end| *end > previous_start && *end < first_start)
            .unwrap_or(previous_start + expected(previous));
        shift(line, group, target as i64 - first_start as i64);
    }
    for group in (0..anchor).rev() {
        let next_start = line.segments[groups[group + 1][0].0].start_ms.unwrap();
        let last = &line.segments[groups[group].last().unwrap().0];
        let target = next_start.saturating_sub(expected(last)).max(last.start_ms.unwrap());
        shift(line, group, target as i64 - last.start_ms.unwrap() as i64);
    }
    if line.start_ms.is_some_and(|start| start <= old_first) {
        line.start_ms = line.segments.iter().find_map(|segment| segment.start_ms);
    }
    if anchor + 1 < groups.len() && line.end_ms.is_some_and(|end| end >= old_last) {
        line.end_ms = None;
    }
}

/// A line ends with its last word. Background vocals keep their own explicit timing, which
/// the line must still cover.
pub(super) fn fit_line_end(line: &mut LyricLine) {
    line.end_ms = line
        .segments
        .iter()
        .filter_map(|segment| segment.end_ms)
        .chain(line.background_vocals.iter().filter_map(|background| background.end_ms))
        .max()
        .or(line.end_ms);
}

fn normalize_line(line: &mut LyricLine, next: Option<u64>, pace: Option<Pace>) {
    let line_end_inferred = line.end_ms.is_none();
    if let Some(start) = line.start_ms {
        line.end_ms = line.end_ms.or(next.filter(|end| *end > start));
    }
    // Text order is authoritative, including scripts without spaces and overlapping spans.
    let reconstructs = line
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<String>()
        == line.text;
    let valid = line.segments.iter().all(|segment| {
        valid_range(segment.start_ms, segment.end_ms)
            && segment.start_ms.is_none_or(|start| {
                line.start_ms.is_none_or(|begin| start >= begin)
                    && line.end_ms.is_none_or(|end| start <= end)
            })
            && segment
                .end_ms
                .is_none_or(|end| line.end_ms.is_none_or(|line_end| end <= line_end))
    });
    if !reconstructs || !valid {
        line.segments.clear();
    }
    if line.segments.is_empty() {
        line.segments.push(Segment::new(
            line.text.clone(),
            line.start_ms,
            line.end_ms,
            if line.start_ms.is_some() {
                "line"
            } else {
                "none"
            },
        ));
    } else {
        let end_inferred = line_end_inferred
            || line
                .segments
                .iter()
                .rev()
                .find(|segment| segment.start_ms.is_some() && letters(&segment.text) > 0)
                .is_some_and(|segment| segment.end_ms.is_none());
        let mut next_start = line.end_ms;
        for segment in line.segments.iter_mut().rev() {
            if let Some(start) = segment.start_ms {
                if segment.end_ms.is_none() {
                    segment.end_ms = next_start.filter(|end| *end > start);
                    segment.end_estimated = segment.end_ms.is_some();
                }
                next_start = Some(start);
            }
        }
        if let Some(pace) = pace.filter(|_| has_detail(line)) {
            repair_final_word(line, pace, end_inferred, next);
        }
    }
    classify_segments(&mut line.segments);
    line.words = if has_detail(line) {
        line.segments.clone()
    } else {
        Vec::new()
    };
    for background in &mut line.background_vocals {
        normalize_line(background, line.end_ms, None);
    }
}

fn classify_segments(segments: &mut [Segment]) {
    // A declared Word format may contain subword pieces. Preserve those pieces as
    // segments without inferring syllables from characters or missing whitespace.
    let mut subword = vec![false; segments.len()];
    for index in 1..segments.len() {
        let (before, after) = segments.split_at_mut(index);
        let left = &mut before[index - 1];
        let right = &mut after[0];
        if left.start_ms.is_some()
            && right.start_ms.is_some()
            && left.start_ms != right.start_ms
            && left.text.chars().last().is_some_and(char::is_alphanumeric)
            && right.text.chars().next().is_some_and(char::is_alphanumeric)
        {
            subword[index - 1] = true;
            subword[index] = true;
        }
    }
    for (segment, subword) in segments.iter_mut().zip(subword) {
        if subword && segment.granularity != "syllable" {
            segment.granularity = "segment";
        }
        if !subword && segment.granularity == "syllable" {
            segment.granularity = "word";
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_word_timed_minutes_after_its_line_is_pulled_back() {
        let words = [("all ", 569_280), ("of ", 570_360), ("my ", 570_600), ("past", 751_360)];
        let mut lyrics = LyricsResponse::empty(Some(false));
        lyrics.lines.push(LyricLine {
            text: words.iter().map(|(text, _)| *text).collect(),
            start_ms: Some(569_280),
            end_ms: Some(752_690),
            segments: words
                .iter()
                .map(|(text, start)| Segment::new(text.to_string(), Some(*start), None, "word"))
                .collect(),
            ..Default::default()
        });
        lyrics.normalize(Some(940_536));
        let line = &lyrics.lines[0];
        let past = line.segments.last().unwrap();
        assert!(past.start_ms.unwrap() < 572_000, "{:?}", past.start_ms);
        assert!(line.end_ms.unwrap() < 575_000, "{:?}", line.end_ms);
        assert!(line.segments[2].end_ms.unwrap() < 572_000);
        assert!(line.segments[..3].iter().all(|segment| segment.end_estimated));
    }

    #[test]
    fn a_last_word_squeezed_by_the_next_line_gets_its_time_back() {
        let line = |text: &str, start: u64, end: u64, words: &[(&str, u64)]| LyricLine {
            text: text.to_owned(),
            start_ms: Some(start),
            end_ms: Some(end),
            segments: words
                .iter()
                .map(|(text, start)| Segment::new(text.to_string(), Some(*start), None, "word"))
                .collect(),
            ..Default::default()
        };
        let mut lyrics = LyricsResponse::empty(Some(false));
        lyrics.lines = vec![
            line("heard the news today?", 21_975, 22_700, &[("heard ", 21_975), ("the ", 22_245), ("news ", 22_400), ("today?", 22_652)]),
            line("People right", 22_700, 25_000, &[("People ", 22_700), ("right", 24_240)]),
        ];
        lyrics.normalize(Some(230_000));
        let today = lyrics.lines[0].segments.last().unwrap();
        let people = &lyrics.lines[1].segments[0];
        assert!(today.end_ms.unwrap() >= 22_652 + 250, "{:?}", today.end_ms);
        assert_eq!(today.end_ms, people.start_ms);
        assert_eq!(lyrics.lines[1].start_ms, people.start_ms);
        assert!(people.start_estimated);
    }

    #[test]
    fn a_first_word_timed_long_before_its_line_moves_up_to_it() {
        let words = [("In ", 70), ("the ", 25_700), ("next ", 25_810), ("world ", 28_310), ("war", 28_915)];
        let mut lyrics = LyricsResponse::empty(Some(false));
        lyrics.lines.push(LyricLine {
            text: words.iter().map(|(text, _)| *text).collect(),
            start_ms: Some(70),
            end_ms: Some(31_100),
            segments: words
                .iter()
                .map(|(text, start)| Segment::new(text.to_string(), Some(*start), None, "word"))
                .collect(),
            ..Default::default()
        });
        lyrics.normalize(Some(280_000));
        let line = &lyrics.lines[0];
        let first = line.segments[0].start_ms.unwrap();
        assert!((25_000..25_700).contains(&first), "{first}");
        assert_eq!(line.start_ms, Some(first));
        assert_eq!(line.segments[0].end_ms, Some(25_700));
        assert!(line.end_ms.is_some_and(|end| end > 28_915 && end <= 31_100), "{:?}", line.end_ms);
    }
}
