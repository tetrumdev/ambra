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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub text: String,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub granularity: &'static str,
    pub singer: Option<String>,
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
            ms_per_letter: ms_per_letter(&self.lines),
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
                segment.end_ms = segment.end_ms.or(next_start.filter(|end| *end > start));
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
