import { invoke } from "@tauri-apps/api/core";
import type { LyricLine, TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import { loadLyrics } from "./lyricsCache";
import { lyricSyncOverride } from "./lyricsSyncOverrides";
import { nativeAudioSource } from "./nativeAudioSource";
import { getPersistentItem, setPersistentItem } from "./persistentStorage";

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

/** Identifies one lyric timing, so a saved result is dropped if the lyrics change. */
function timingKey(lyrics: TrackLyrics, windows: LyricWindow[]): string {
  return JSON.stringify([lyrics.source, lyrics.offsetMs, windows.length,
    windows[0]?.startMs, windows[windows.length - 1]?.endMs]);
}

export type DetectedOffset = {
  /** Milliseconds to add to `lyrics.offsetMs`; 0 when no reliable shift exists. */
  correctionMs: number;
  confident: boolean;
};

// Confident results are kept across sessions so each song is analyzed once.
const storageKey = "ambra.lyrics-autosync.v1";
const MAX_TRACKS = 2000;

type StoredOffsets = Record<string, { timing: string; correctionMs: number }>;

function readStoredOffsets(): StoredOffsets {
  try {
    const value: unknown = JSON.parse(getPersistentItem(storageKey) ?? "{}");
    if (typeof value !== "object" || value === null) return {};
    const offsets: StoredOffsets = {};
    for (const [trackId, entry] of Object.entries(value)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { timing, correctionMs } = entry as Record<string, unknown>;
      if (typeof timing === "string" && typeof correctionMs === "number" && Number.isFinite(correctionMs))
        offsets[trackId] = { timing, correctionMs };
    }
    return offsets;
  } catch {
    return {};
  }
}

function storeOffset(trackId: string, timing: string, correctionMs: number) {
  const offsets = readStoredOffsets();
  // Reinserting keeps the most recently analyzed tracks at the end.
  delete offsets[trackId];
  offsets[trackId] = { timing, correctionMs };
  const trackIds = Object.keys(offsets);
  for (const stale of trackIds.slice(0, Math.max(0, trackIds.length - MAX_TRACKS))) delete offsets[stale];
  try {
    setPersistentItem(storageKey, JSON.stringify(offsets));
  } catch (error) {
    console.warn("Could not save lyric auto-sync:", error);
  }
}

/** A correction found for these lyrics in an earlier analysis, if any. */
export function storedLyricOffset(track: Track, lyrics: TrackLyrics): number | undefined {
  const stored = readStoredOffsets()[track.globalId];
  return stored?.timing === timingKey(lyrics, lyricWindows(lyrics)) ? stored.correctionMs : undefined;
}

type Analysis = {
  key: string;
  trackId: string;
  timing: string;
  args: { source: string; windows: LyricWindow[] };
  background: boolean;
  /** Set when a foreground analysis cut this background one off, so it is queued again. */
  preempted: boolean;
  promise: Promise<DetectedOffset>;
  resolve: (result: DetectedOffset) => void;
  reject: (error: unknown) => void;
};

// Session-only bookkeeping: one analysis per recording and lyric timing.
const analyses = new Map<string, Analysis>();
// The native analysis supersedes whatever ran before it, so only one runs at a time.
const backlog: Analysis[] = [];
let running: Analysis | null = null;

function start(analysis: Analysis) {
  if (running?.background) running.preempted = true;
  running = analysis;
  analysis.preempted = false;
  invoke<DetectedOffset>("detect_lyric_offset", analysis.args)
    .then(
      (result) => {
        if (result.confident) storeOffset(analysis.trackId, analysis.timing, result.correctionMs);
        analysis.resolve(result);
      },
      (error) => {
        if (analysis.preempted) {
          backlog.unshift(analysis);
          return;
        }
        // A superseded or failed analysis may be retried when the song is shown again.
        analyses.delete(analysis.key);
        analysis.reject(error);
      },
    )
    .finally(() => {
      if (running === analysis) running = null;
      pump();
    });
}

function pump() {
  if (!running && backlog.length) start(backlog.shift()!);
}

/**
 * Finds a constant shift between the lyrics and the recording. Foreground requests run
 * straight away; background ones wait their turn behind anything already running.
 */
export function detectLyricOffset(track: Track, lyrics: TrackLyrics, background = false): Promise<DetectedOffset> {
  const windows = lyricWindows(lyrics);
  const timing = timingKey(lyrics, windows);
  const stored = readStoredOffsets()[track.globalId];
  if (stored?.timing === timing) return Promise.resolve({ correctionMs: stored.correctionMs, confident: true });
  const source = nativeAudioSource(track);
  const key = JSON.stringify([source, timing]);
  const existing = analyses.get(key);
  if (existing) {
    if (!background && existing.background) {
      existing.background = false;
      const queued = backlog.indexOf(existing);
      if (queued >= 0) {
        backlog.splice(queued, 1);
        start(existing);
      }
    }
    return existing.promise;
  }
  let resolve!: (result: DetectedOffset) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<DetectedOffset>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const analysis: Analysis = {
    key, trackId: track.globalId, timing, args: { source, windows },
    background, preempted: false, promise, resolve, reject,
  };
  analyses.set(key, analysis);
  if (background) {
    backlog.push(analysis);
    pump();
  } else {
    start(analysis);
  }
  return promise;
}

/**
 * Analyzes songs ahead of playback, in queue order, so their lyrics open already in sync.
 * Songs the listener has retimed or unsynced themselves are left alone.
 */
export async function prepareLyricSync(tracks: Track[]): Promise<void> {
  for (const track of tracks) {
    try {
      const override = lyricSyncOverride(track.globalId);
      if (override?.correctionMs !== undefined || override?.unsynced) continue;
      const lyrics = await loadLyrics(track);
      if (lyrics.status !== "lyrics" || lyrics.sync === "none") continue;
      await detectLyricOffset(track, lyrics, true);
    } catch {
      // Unavailable lyrics or audio leave the song to be analyzed when it is shown.
    }
  }
}
