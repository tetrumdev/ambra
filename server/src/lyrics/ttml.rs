use super::{
    formats::{MAX_RESPONSE_BYTES, timestamp_ms},
    model::{
        Annotation, LyricLine, LyricsResponse, MAX_LINES, MAX_SEGMENTS, Segment, Singer,
        valid_range,
    },
};
use quick_xml::{Reader, events::Event};
use std::{collections::BTreeMap, io};

#[derive(Default)]
struct Node {
    name: String,
    attributes: BTreeMap<String, String>,
    children: Vec<Content>,
}

enum Content {
    Text(String),
    Element(Node),
}

impl Node {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attributes.get(name).map(String::as_str)
    }
    fn elements(&self) -> impl Iterator<Item = &Node> {
        self.children.iter().filter_map(|content| match content {
            Content::Element(node) => Some(node),
            _ => None,
        })
    }
    fn text(&self) -> String {
        self.children
            .iter()
            .map(|content| match content {
                Content::Text(text) => text.clone(),
                Content::Element(node) => node.text(),
            })
            .collect()
    }
}

fn xml(raw: &str) -> Result<Node, io::Error> {
    if raw.len() > MAX_RESPONSE_BYTES {
        return Err(io::Error::other("TTML is too large"));
    }
    let mut reader = Reader::from_str(raw);
    let mut stack: Vec<Node> = Vec::new();
    let mut root = None;
    let mut count = 0;
    loop {
        let event = reader.read_event().map_err(io::Error::other)?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(element) | Event::Empty(element) => {
                count += 1;
                if stack.len() >= 64 || count > MAX_SEGMENTS * 3 {
                    return Err(io::Error::other("TTML complexity limit exceeded"));
                }
                let name = std::str::from_utf8(element.local_name().as_ref())
                    .map_err(io::Error::other)?
                    .to_owned();
                let mut node = Node {
                    name,
                    ..Default::default()
                };
                for attribute in element.attributes() {
                    let attribute = attribute.map_err(io::Error::other)?;
                    // Namespace declarations are not semantic attributes.
                    if attribute.key.as_ref().starts_with(b"xmlns") {
                        continue;
                    }
                    let key = std::str::from_utf8(attribute.key.local_name().as_ref())
                        .map_err(io::Error::other)?
                        .to_owned();
                    let value = attribute
                        .decoded_and_normalized_value(
                            quick_xml::XmlVersion::Implicit1_0,
                            reader.decoder(),
                        )
                        .map_err(io::Error::other)?
                        .into_owned();
                    if node.attributes.insert(key, value).is_some() {
                        return Err(io::Error::other("Ambiguous TTML attributes"));
                    }
                }
                if empty {
                    if let Some(parent) = stack.last_mut() {
                        parent.children.push(Content::Element(node));
                    } else if root.replace(node).is_some() {
                        return Err(io::Error::other("Multiple XML roots"));
                    }
                } else {
                    stack.push(node);
                }
            }
            Event::End(_) => {
                let node = stack
                    .pop()
                    .ok_or_else(|| io::Error::other("Unbalanced XML"))?;
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(Content::Element(node));
                } else if root.replace(node).is_some() {
                    return Err(io::Error::other("Multiple XML roots"));
                }
            }
            Event::Text(text) => {
                let text = text.xml10_content().map_err(io::Error::other)?.into_owned();
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(Content::Text(text));
                } else if !text.trim().is_empty() {
                    return Err(io::Error::other("Text outside XML root"));
                }
            }
            Event::CData(text) => {
                let parent = stack
                    .last_mut()
                    .ok_or_else(|| io::Error::other("CDATA outside XML root"))?;
                parent.children.push(Content::Text(
                    text.decode().map_err(io::Error::other)?.into_owned(),
                ));
            }
            Event::GeneralRef(reference) => {
                let decoded = reference.decode().map_err(io::Error::other)?;
                let escaped = format!("&{decoded};");
                let text = quick_xml::escape::unescape(&escaped)
                    .map_err(io::Error::other)?
                    .into_owned();
                let parent = stack
                    .last_mut()
                    .ok_or_else(|| io::Error::other("Entity outside XML root"))?;
                parent.children.push(Content::Text(text));
            }
            Event::DocType(_) => return Err(io::Error::other("TTML DTDs are forbidden")),
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(io::Error::other("Truncated TTML"));
    }
    root.filter(|node| node.name == "tt")
        .ok_or_else(|| io::Error::other("Missing TTML root"))
}

pub fn parse(raw: &str, duration_ms: Option<u64>) -> Result<LyricsResponse, io::Error> {
    let root = xml(raw)?;
    if root.attr("timeBase").is_some_and(|value| value != "media") {
        return Err(io::Error::other("Unsupported TTML time base"));
    }
    let mut result = LyricsResponse::empty(Some(false));
    result.original_format = Some("ttml");
    result.language = root.attr("lang").map(str::to_owned);
    // Format declarations describe intent, not proof of detailed timing.
    let declared = root.attr("timing").unwrap_or("");
    let granularity = match declared.to_ascii_lowercase().as_str() {
        "syllable" => "syllable",
        "word" => "word",
        _ => "segment",
    };
    for node in root.elements() {
        if node.name == "head" {
            metadata(node, &mut result);
        }
        if node.name == "body" {
            collect_lines(node, None, None, None, granularity, &mut result.lines)?;
        }
    }
    if result.lines.len() > MAX_LINES
        || result.lines.iter().map(segment_count).sum::<usize>() > MAX_SEGMENTS
    {
        return Err(io::Error::other("Too many TTML lines or segments"));
    }
    // iTunes/lrc.red metadata can store translations separately, keyed to a p element.
    for head in root.elements().filter(|node| node.name == "head") {
        annotations(head, None, None, &mut result.lines);
    }
    result.normalize(duration_ms);
    if result.plain_lyrics.is_none() && !result.lines.is_empty() {
        result.plain_lyrics = Some(
            result
                .lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
    Ok(result)
}

fn segment_count(line: &LyricLine) -> usize {
    line.segments.len()
        + line
            .background_vocals
            .iter()
            .map(segment_count)
            .sum::<usize>()
        + line
            .translations
            .iter()
            .chain(&line.romanization)
            .map(|annotation| annotation.segments.len())
            .sum::<usize>()
}

fn timing(
    node: &Node,
    inherited_start: Option<u64>,
    inherited_end: Option<u64>,
) -> Result<(Option<u64>, Option<u64>), io::Error> {
    let parse = |name| {
        node.attr(name)
            .map(|value| {
                timestamp_ms(value).ok_or_else(|| io::Error::other("Invalid TTML timestamp"))
            })
            .transpose()
    };
    let start = parse("begin")?.or(inherited_start);
    let end = parse("end")?
        .or(parse("dur")?.and_then(|dur| start.unwrap_or(0).checked_add(dur)))
        .or(inherited_end);
    if !valid_range(start, end) {
        return Err(io::Error::other("Invalid TTML timing range"));
    }
    Ok((start, end))
}

fn collect_lines(
    node: &Node,
    start: Option<u64>,
    end: Option<u64>,
    singer: Option<&str>,
    granularity: &'static str,
    lines: &mut Vec<LyricLine>,
) -> Result<(), io::Error> {
    let (start, end) = timing(node, start, end)?;
    let singer = node.attr("agent").or(singer);
    if node.name == "p" {
        // Container duration is not a per-line end. Missing line ends are inferred
        // from timed spans or the following line, rather than keeping every line active.
        let line_end = if node.attr("end").is_some() || node.attr("dur").is_some() {
            end
        } else {
            None
        };
        lines.push(line(node, start, line_end, singer, granularity)?);
        if lines.len() > MAX_LINES {
            return Err(io::Error::other("Too many TTML lines"));
        }
    } else {
        for child in node.elements() {
            collect_lines(child, start, end, singer, granularity, lines)?;
        }
    }
    Ok(())
}

fn line(
    node: &Node,
    start: Option<u64>,
    end: Option<u64>,
    singer: Option<&str>,
    granularity: &'static str,
) -> Result<LyricLine, io::Error> {
    let mut line = LyricLine {
        start_ms: start,
        end_ms: end,
        singer: singer.map(str::to_owned),
        key: node.attr("key").map(str::to_owned),
        ..Default::default()
    };
    collect_segments(node, None, None, singer, granularity, &mut line)?;
    while line
        .segments
        .first()
        .is_some_and(|segment| segment.text.trim().is_empty())
    {
        line.segments.remove(0);
    }
    while line
        .segments
        .last()
        .is_some_and(|segment| segment.text.trim().is_empty())
    {
        line.segments.pop();
    }
    line.text = line
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect();
    if line.start_ms.is_none() {
        line.start_ms = line
            .segments
            .iter()
            .filter_map(|segment| segment.start_ms)
            .min();
    }
    if line.end_ms.is_none() {
        line.end_ms = line
            .segments
            .iter()
            .filter_map(|segment| segment.end_ms)
            .max();
    }
    Ok(line)
}

fn collect_segments(
    node: &Node,
    start: Option<u64>,
    end: Option<u64>,
    singer: Option<&str>,
    granularity: &'static str,
    line: &mut LyricLine,
) -> Result<(), io::Error> {
    for child in &node.children {
        match child {
            Content::Text(text) => {
                let text = if node.attr("space") == Some("preserve") {
                    text.clone()
                } else {
                    collapse_space(text)
                };
                if text.is_empty() {
                    continue;
                }
                if let Some(last) = line.segments.last_mut().filter(|last| {
                    last.start_ms == start && last.end_ms == end && last.singer.as_deref() == singer
                }) {
                    last.text.push_str(&text);
                } else {
                    let mut segment = Segment::new(
                        text,
                        start,
                        end,
                        if start.is_some() { granularity } else { "none" },
                    );
                    segment.singer = singer.map(str::to_owned);
                    line.segments.push(segment);
                }
            }
            Content::Element(child) => {
                let role = child.attr("role").unwrap_or("");
                let child_singer = child.attr("agent").or(singer);
                if role == "x-bg" {
                    let (bg_start, bg_end) = timing(child, None, None)?;
                    let mut background =
                        self::line(child, bg_start, bg_end, child_singer, granularity)?;
                    background.start_ms = background.start_ms.or(line.start_ms);
                    background.end_ms = background.end_ms.or(line.end_ms);
                    let nested = std::mem::take(&mut background.background_vocals);
                    line.background_vocals.push(background);
                    line.background_vocals.extend(nested);
                } else if matches!(role, "x-translation" | "x-roman" | "x-romanization") {
                    let mut annotation_line = LyricLine::default();
                    collect_segments(
                        child,
                        None,
                        None,
                        child_singer,
                        granularity,
                        &mut annotation_line,
                    )?;
                    let annotation = Annotation {
                        language: child.attr("lang").map(str::to_owned),
                        segments: annotation_line.segments,
                    };
                    if role == "x-translation" {
                        line.translations.push(annotation);
                    } else {
                        line.romanization.push(annotation);
                    }
                } else if child.name == "br" {
                    line.segments
                        .push(Segment::new("\n".into(), None, None, "none"));
                } else {
                    let (child_start, child_end) = timing(child, start, end)?;
                    let finer = if role == "x-syllable" {
                        "syllable"
                    } else {
                        granularity
                    };
                    collect_segments(child, child_start, child_end, child_singer, finer, line)?;
                }
            }
        }
    }
    Ok(())
}

fn collapse_space(text: &str) -> String {
    let mut result = String::new();
    let mut space = false;
    for character in text.chars() {
        if character.is_whitespace() {
            if !space {
                result.push(' ');
            }
            space = true;
        } else {
            result.push(character);
            space = false;
        }
    }
    result
}

fn metadata(node: &Node, result: &mut LyricsResponse) {
    if node.name == "agent" {
        if let Some(id) = node.attr("id") {
            result.singers.push(Singer {
                id: id.to_owned(),
                name: node
                    .elements()
                    .find(|node| node.name == "name")
                    .map(Node::text)
                    .filter(|name| !name.trim().is_empty()),
            });
        }
    }
    for child in node.elements() {
        metadata(child, result);
    }
}

fn annotations(node: &Node, kind: Option<&str>, language: Option<&str>, lines: &mut [LyricLine]) {
    let kind = match node.name.as_str() {
        "translation" => Some("translation"),
        "transliteration" | "romanization" => Some("romanization"),
        _ => kind,
    };
    let language = node.attr("lang").or(language);
    if let (Some(kind), Some(key)) = (kind, node.attr("for")) {
        if let Some(line) = lines
            .iter_mut()
            .find(|line| line.key.as_deref() == Some(key))
        {
            let annotation = Annotation {
                language: language.map(str::to_owned),
                segments: vec![Segment::new(node.text(), None, None, "none")],
            };
            if kind == "translation" {
                line.translations.push(annotation);
            } else {
                line.romanization.push(annotation);
            }
        }
    }
    for child in node.elements() {
        annotations(child, kind, language, lines);
    }
}
