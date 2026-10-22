import { invoke } from "@tauri-apps/api/core";
import type { LyricLine, TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import { loadLyrics } from "./lyricsCache";
import { bestCorrection, type OffsetEvidence, trustedCorrection } from "./lyricsAutoTuning";
import { lyricSyncOverride } from "./lyricsSyncOverrides";
import { nativeAudioSource } from "./nativeAudioSource";
import { getPersistentItem, setPersistentItem } from "./persistentStorage";

type LyricWindow = { startMs: number; endMs: number };

// Line-only timings rarely carry ends; assume a line is sung for at most this long.
const LINE_FALLBACK_MS = 6000;
/** Longer than any sung line; a final line is sometimes timed as held through the whole outro. */
export const MAX_LINE_MS = 15_000;

/** Sung intervals on the audio timeline the lyrics currently assume. */
function lyricWindows(lyrics: TrackLyrics): LyricWindow[] {
  const windows: LyricWindow[] = [];
  const add = (line: LyricLine, nextStart: number | null) => {
    if (!line.text.trim() || line.startMs === null) return;
    const timed = line.segments.filter(segment => segment.text.trim()
      && segment.startMs !== null && segment.endMs !== null && segment.endMs > segment.startMs);
    const spans = timed.length > 1
      ? timed.map(segment => [segment.startMs!, segment.endMs!])
      : [[line.startMs, Math.min(line.endMs ?? Math.min(nextStart ?? Infinity, line.startMs + LINE_FALLBACK_MS), line.startMs + MAX_LINE_MS)]];
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
  /** The correction at the best match even when it is not trusted; null when nothing could be scored. */
  bestMs: number | null;
  /** Playback milliseconds where the singing stops; null when the recording can't tell. */
  vocalEndMs: number | null;
};

function decide(evidence: OffsetEvidence): DetectedOffset {
  const correctionMs = trustedCorrection(evidence);
  const bestMs = bestCorrection(evidence);
  const vocalEndMs = evidence.vocalEndMs ?? null;
  return correctionMs === null ? { correctionMs: 0, confident: false, bestMs, vocalEndMs } : { correctionMs, confident: true, bestMs, vocalEndMs };
}

// Evidence is kept across sessions so each song is analyzed once; whether it is trusted
// is decided on read, so it follows the tuning as the listener's corrections refine it.
const storageKey = "ambra.lyrics-autosync.v2";
const MAX_TRACKS = 2000;
/** Raised when vocal endings are measured differently, so songs where none was found are heard again. */
const ENDING_VERSION = 3;

type StoredOffsets = Record<string, OffsetEvidence & { timing: string; ending?: number }>;

function readStoredOffsets(): StoredOffsets {
  try {
    const value: unknown = JSON.parse(getPersistentItem(storageKey) ?? "{}");
    if (typeof value !== "object" || value === null) return {};
    const offsets: StoredOffsets = {};
    for (const [trackId, entry] of Object.entries(value)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { timing, bestMs, prominence, margin, vocalEndMs, ending } = entry as Record<string, unknown>;
      if (typeof timing !== "string" || typeof prominence !== "number" || !Number.isFinite(prominence)) continue;
      // Analyzed before vocal endings were measured, so the song is analyzed again once.
      if (!("vocalEndMs" in entry)) continue;
      if (vocalEndMs === null && ending !== ENDING_VERSION) continue;
      offsets[trackId] = {
        timing,
        bestMs: typeof bestMs === "number" && Number.isFinite(bestMs) ? bestMs : null,
        prominence,
        margin: typeof margin === "number" && Number.isFinite(margin) ? margin : null,
        vocalEndMs: typeof vocalEndMs === "number" && Number.isFinite(vocalEndMs) ? vocalEndMs : null,
        ...(typeof ending === "number" ? { ending } : {}),
      };
    }
    return offsets;
  } catch {
    return {};
  }
}

function storeOffset(trackId: string, timing: string, evidence: OffsetEvidence) {
  const offsets = readStoredOffsets();
  // Reinserting keeps the most recently analyzed tracks at the end.
  delete offsets[trackId];
  offsets[trackId] = { timing, ...evidence, ending: ENDING_VERSION };
  const trackIds = Object.keys(offsets);
  for (const stale of trackIds.slice(0, Math.max(0, trackIds.length - MAX_TRACKS))) delete offsets[stale];
  try {
    setPersistentItem(storageKey, JSON.stringify(offsets));
  } catch (error) {
    console.warn("Could not save lyric auto-sync:", error);
  }
}

/** What an earlier analysis of these lyrics found, if any, with the timing it was taken against. */
export function storedLyricEvidence(track: Track, lyrics: TrackLyrics): (OffsetEvidence & { timing: string }) | undefined {
  const stored = readStoredOffsets()[track.globalId];
  return stored?.timing === timingKey(lyrics, lyricWindows(lyrics)) ? stored : undefined;
}

/** A trusted correction found for these lyrics in an earlier analysis, if any. */
export function storedLyricOffset(track: Track, lyrics: TrackLyrics): number | undefined {
  const stored = storedLyricEvidence(track, lyrics);
  if (!stored) return undefined;
  const result = decide(stored);
  return result.confident ? result.correctionMs : undefined;
}

// The corrections each song has already announced, so a song only says it was auto-synced once.
const noticedKey = "ambra.lyrics-autosync-noticed.v1";

/** Whether this correction is new for the song, in which case it is remembered as announced. */
export function firstAutoSyncNotice(trackId: string, correctionMs: number): boolean {
  let noticed: Record<string, number> = {};
  try {
    const value: unknown = JSON.parse(getPersistentItem(noticedKey) ?? "{}");
    if (typeof value === "object" && value !== null) noticed = value as Record<string, number>;
  } catch {
    // A damaged record only means a notice is shown again.
  }
  if (noticed[trackId] === correctionMs) return false;
  // Reinserting keeps the most recently announced tracks at the end.
  delete noticed[trackId];
  noticed[trackId] = correctionMs;
  const trackIds = Object.keys(noticed);
  for (const stale of trackIds.slice(0, Math.max(0, trackIds.length - MAX_TRACKS))) delete noticed[stale];
  try {
    setPersistentItem(noticedKey, JSON.stringify(noticed));
  } catch (error) {
    console.warn("Could not save lyric auto-sync notice:", error);
  }
  return true;
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
  invoke<OffsetEvidence>("detect_lyric_offset", analysis.args)
    .then(
      (evidence) => {
        storeOffset(analysis.trackId, analysis.timing, evidence);
        analysis.resolve(decide(evidence));
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
  if (stored?.timing === timing) return Promise.resolve(decide(stored));
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
