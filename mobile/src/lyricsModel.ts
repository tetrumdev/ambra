import type { LyricAnnotation, LyricLine, TrackLyrics } from "../../desktop/src/utils/lyricsWire";
import { lyricDisplayLine } from "../../desktop/src/utils/lyricTypography";
import { letterMotion, type LetterMotion } from "../../desktop/src/utils/lyricsMotion";
import { detailedLine, lyricActive, sweepSegments } from "../../desktop/src/utils/lyricsTiming";
import type { Track } from "./client";

export type LyricWord = { text: string; letters: { text: string; motion: LetterMotion }[]; space: boolean };
export type LyricWordRun = LyricWord & { trailing: string; break: boolean };

/** A soft space stays with the preceding word, so wrapping cannot indent the next visual line. */
export function lyricWordRuns(words: LyricWord[]): LyricWordRun[] {
  const runs: LyricWordRun[] = [];
  for (const word of words) {
    if (!word.space) { runs.push({ ...word, trailing: "", break: false }); continue; }
    if (/[\r\n]/.test(word.text)) {
      const count = word.text.match(/\r\n|\r|\n/g)?.length ?? 0;
      for (let index = 0; index < count; index++) runs.push({ ...word, trailing: "", break: true });
    } else {
      const previous = runs[runs.length - 1];
      if (previous && !previous.break) previous.trailing += word.text;
    }
  }
  return runs;
}
export type LyricRow = { id: string; line: LyricLine; kind: "lead" | "background" | "romanization"; alternate: boolean; singer: string; words: LyricWord[] };
export type LyricBlock = { kind: "lines"; id: string; line: number; rows: LyricRow[] } | { kind: "pause"; id: string; startMs: number; endMs: number };

export function lyricsKey(track: Track) {
  return JSON.stringify([track.globalId, track.name, track.artist, track.album, track.durationSeconds, track.providerTrackId, track.isrc, track.version]);
}

type Segmenter = { segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }> };
const SegmenterClass = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" | "word" }) => Segmenter }).Segmenter;
function segmenter(language: string | null, granularity: "grapheme" | "word") {
  try { return SegmenterClass ? new SegmenterClass(language || undefined, { granularity }) : null; } catch { return null; }
}

/** Keep words intact while preserving each grapheme's original provider timing. */
export function lyricWords(line: LyricLine, language: string | null): LyricWord[] {
  if (!detailedLine(line)) return [];
  const segments = sweepSegments(line);
  const grapheme = segmenter(language, "grapheme");
  const dictionary = segmenter(language, "word");
  const pieces = line.text.split(/(\s+)/).flatMap(token => {
    if (!token || /^\s+$/.test(token)) return token ? [token] : [];
    if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(token)) return token.match(/[^-‐‑–—/]*[-‐‑–—/]+|[^-‐‑–—/]+/g) ?? [token];
    return dictionary ? Array.from(dictionary.segment(token), part => part.segment) : Array.from(token);
  });
  let segmentIndex = 0;
  let boundary = segments[0]?.text.length ?? 0;
  let offset = 0;
  const counts = segments.map(() => 0);
  const words = pieces.map(text => {
    if (/^\s+$/.test(text)) { offset += text.length; return { text, space: true, letters: [] }; }
    return { text, space: false, letters: (grapheme ? Array.from(grapheme.segment(text), part => part.segment) : Array.from(text)).map(text => {
    while (segmentIndex + 1 < segments.length && offset >= boundary) boundary += segments[++segmentIndex].text.length;
    offset += text.length;
    return { text, segment: segmentIndex, index: counts[segmentIndex]++ };
  }) }; });
  return words.map(word => ({ ...word, letters: word.letters.map(letter => ({ text: letter.text, motion: letterMotion(segments[letter.segment], letter.index, counts[letter.segment]) })) }));
}

function annotationLine(annotation: LyricAnnotation, parent: LyricLine): LyricLine {
  const starts = annotation.segments.flatMap(segment => segment.startMs === null ? [] : [segment.startMs]);
  const ends = annotation.segments.flatMap(segment => segment.endMs === null ? [] : [segment.endMs]);
  return { ...parent, text: annotation.segments.map(segment => segment.text).join(""), segments: annotation.segments, startMs: starts.length ? Math.min(...starts) : parent.startMs, endMs: ends.length ? Math.max(...ends) : parent.endMs };
}

export function lyricBlocks(lyrics: TrackLyrics): LyricBlock[] {
  const ids = lyrics.singers.map(singer => singer.id);
  for (const line of lyrics.lines.flatMap(line => [line, ...line.backgroundVocals])) {
    for (const id of [line.singer, ...line.segments.map(segment => segment.singer)]) if (id && !ids.includes(id)) ids.push(id);
  }
  const blocks: LyricBlock[] = [];
  let leadVoices = "";
  let previousEnd = 0;
  const timed = lyrics.sync !== "none";
  lyrics.lines.forEach((raw, index) => {
    // Line-only providers can omit ends. A later lead line must supersede that open-ended line.
    const nextStart = raw.endMs === null && raw.startMs !== null
      ? lyrics.lines.slice(index + 1).find(line => line.startMs !== null && line.startMs > raw.startMs!)?.startMs : undefined;
    const source = nextStart !== undefined && nextStart !== null ? { ...raw, endMs: nextStart } : raw;
    if (timed && source.startMs !== null && source.startMs - previousEnd >= 4000) blocks.push({ kind: "pause", id: `pause-${index}`, startMs: previousEnd, endMs: source.startMs });
    if (timed && !source.text.trim() && !source.backgroundVocals.length) { if (source.startMs !== null) previousEnd = source.startMs; return; }
    const rows: LyricRow[] = [];
    const add = (raw: LyricLine, id: string, kind: LyricRow["kind"]) => {
      const line = lyricDisplayLine(raw);
      const voices = [...new Set([line.singer, ...line.segments.map(segment => segment.singer)].filter((id): id is string => id !== null))];
      const key = voices.join("\n");
      const singer = ids.length > 1 && key !== leadVoices && kind !== "romanization" ? voices.map(id => lyrics.singers.find(singer => singer.id === id)?.name ?? `Voice ${ids.indexOf(id) + 1}`).join(" / ") : "";
      if (kind === "lead") leadVoices = key;
      rows.push({ id, line, kind, alternate: line.singer ? ids.indexOf(line.singer) % 2 === 1 : false, singer, words: lyricWords(line, lyrics.language) });
    };
    const annotations = (line: LyricLine, prefix: string) => line.romanization.forEach((annotation, index) => add(annotationLine(annotation, line), `${prefix}-romanization-${index}`, "romanization"));
    add(source, String(index), "lead");
    annotations(source, String(index));
    source.backgroundVocals.forEach((line, sub) => { const id = `${index}-bg-${sub}`; add(line, id, "background"); annotations(line, id); });
    blocks.push({ kind: "lines", id: String(index), line: index, rows });
    const ends = [source.endMs, ...source.backgroundVocals.map(line => line.endMs)].filter((end): end is number => end !== null);
    previousEnd = ends.length ? Math.max(...ends) : Infinity;
  });
  return blocks;
}

export function focusBlock(lyrics: TrackLyrics, blocks: LyricBlock[], timeMs: number) {
  "worklet";
  const pause = blocks.findIndex(block => block.kind === "pause" && timeMs >= block.startMs && timeMs < block.endMs);
  if (pause >= 0) return pause;
  const lead = blocks.findIndex(block => block.kind === "lines" && block.rows[0].line.text.trim() && lyricActive(block.rows[0].line, timeMs));
  if (lead >= 0) return lead;
  const background = blocks.findIndex(block => block.kind === "lines" && block.rows.some(row => row.kind === "background" && lyricActive(row.line, timeMs)));
  if (background >= 0) return background;
  let previous = -1;
  blocks.forEach((block, index) => { const start = block.kind === "pause" ? block.startMs : lyrics.lines[block.line].startMs; if (start !== null && start <= timeMs) previous = index; });
  return previous >= 0 ? previous : 0;
}

export function lyricSeekSeconds(startMs: number, offsetMs: number) { return Math.max(0, (startMs - offsetMs) / 1000); }
