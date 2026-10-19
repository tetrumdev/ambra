use serde::Serialize;

pub const MAX_TIME_MS: u64 = 86_400_000;
pub const MAX_LINES: usize = 5000;
pub const MAX_SEGMENTS: usize = 30_000;

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
        let mut next = duration_ms;
        for group in self
            .lines
            .chunk_by_mut(|a, b| a.start_ms == b.start_ms)
            .rev()
        {
            let start = group[0].start_ms;
            for line in group {
                normalize_line(line, next);
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

fn normalize_line(line: &mut LyricLine, next: Option<u64>) {
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
        let mut next_start = line.end_ms;
        for segment in line.segments.iter_mut().rev() {
            if let Some(start) = segment.start_ms {
                segment.end_ms = segment.end_ms.or(next_start.filter(|end| *end > start));
                next_start = Some(start);
            }
        }
    }
    classify_segments(&mut line.segments);
    line.words = if has_detail(line) {
        line.segments.clone()
    } else {
        Vec::new()
    };
    for background in &mut line.background_vocals {
        normalize_line(background, line.end_ms);
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
