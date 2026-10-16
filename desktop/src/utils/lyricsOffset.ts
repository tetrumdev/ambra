import { invoke } from "@tauri-apps/api/core";
import type { LyricLine, TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import { nativeAudioSource } from "./nativeAudioSource";

type LyricWindow = { startMs: number; endMs: number };

// Line-only timings rarely carry ends; assume a line is sung for at most this long.
const LINE_FALLBACK_MS = 6000;

/** Sung intervals on the audio timeline the lyrics currently assume. */
function lyricWindows(lyrics: TrackLyrics): LyricWindow[] {
  const windows: LyricWindow[] = [];
  const add = (line: LyricLine, nextStart: number | null) => {
    if (!line.text.trim() || line.startMs === null) return;
    const timed = line.segments.filter(segment => segment.text.trim()
      && segment.startMs !== null && segment.endMs !== null && segment.endMs > segment.startMs);
    const spans = timed.length > 1
      ? timed.map(segment => [segment.startMs!, segment.endMs!])
      : [[line.startMs, line.endMs ?? Math.min(nextStart ?? Infinity, line.startMs + LINE_FALLBACK_MS)]];
    for (const [start, end] of spans) {
      if (end > start) windows.push({ startMs: start - lyrics.offsetMs, endMs: end - lyrics.offsetMs });
    }
  };
  lyrics.lines.forEach((line, index) => {
    const nextStart = lyrics.lines.slice(index + 1).find(next => next.startMs !== null && next.startMs > line.startMs!)?.startMs ?? null;
    add(line, nextStart);
    for (const background of line.backgroundVocals) add(background, nextStart);
  });
  return windows;
}

export type DetectedOffset = {
  /** Milliseconds to add to `lyrics.offsetMs`; 0 when no reliable shift exists. */
  correctionMs: number;
  confident: boolean;
};

// Session-only: one analysis per recording and lyric timing, never persisted.
const corrections = new Map<string, Promise<DetectedOffset>>();

export function detectLyricOffset(track: Track, lyrics: TrackLyrics): Promise<DetectedOffset> {
  const source = nativeAudioSource(track);
  const windows = lyricWindows(lyrics);
  const key = JSON.stringify([source, lyrics.source, lyrics.offsetMs, windows.length,
    windows[0]?.startMs, windows[windows.length - 1]?.endMs]);
  let correction = corrections.get(key);
  if (!correction) {
    correction = invoke<DetectedOffset>("detect_lyric_offset", { source, windows });
    // A superseded or failed analysis may be retried when the song is shown again.
    correction.catch(() => corrections.delete(key));
    corrections.set(key, correction);
  }
  return correction;
}
