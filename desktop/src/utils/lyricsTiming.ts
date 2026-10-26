import type { LyricLine, LyricSegment } from "../types/lyrics";

export function lyricActive(timing: Pick<LyricSegment, "startMs" | "endMs">, timeMs: number): boolean {
  "worklet";
  return timing.startMs !== null && timeMs >= timing.startMs && (timing.endMs === null || timeMs < timing.endMs);
}

export function segmentProgress(segment: LyricSegment, timeMs: number): number {
  if (segment.startMs === null || timeMs < segment.startMs) return 0;
  if (segment.endMs === null || segment.endMs <= segment.startMs) return 1;
  return Math.min(1, Math.max(0, (timeMs - segment.startMs) / (segment.endMs - segment.startMs)));
}

/** Line timing gets a uniform highlight; only real internal timings get a sweep. */
export function detailedLine(line: LyricLine): boolean {
  const timed = line.segments.filter(segment => segment.startMs !== null && segment.endMs !== null
    && segment.endMs > segment.startMs && segment.text.trim());
  return timed.some(segment => segment.startMs !== timed[0]?.startMs || segment.endMs !== timed[0]?.endMs);
}

/** Shortest sweep a sung word gets; providers sometimes time words at a few milliseconds. */
const MIN_SWEEP_MS = 120;

/**
 * Sweep timings with near-instant words widened to MIN_SWEEP_MS, borrowing from the
 * silence or the neighbouring words around them without making those too short.
 * Only the sweep uses these; line timing and focus keep the provider's values.
 */
export function sweepSegments(line: LyricLine): LyricSegment[] {
  const segments = line.segments.map(segment => ({ ...segment }));
  const timed = segments.filter(segment => segment.startMs !== null && segment.endMs !== null && segment.text.trim());
  const lineStart = line.startMs ?? -Infinity;
  const lineEnd = line.endMs ?? Infinity;
  for (const [index, segment] of timed.entries()) {
    let start = segment.startMs!;
    let end = segment.endMs!;
    if (end - start >= MIN_SWEEP_MS) continue;
    const previous = timed[index - 1];
    const next = timed[index + 1];
    const floor = previous ? Math.max(lineStart, previous.startMs! + MIN_SWEEP_MS) : lineStart;
    start = Math.max(Math.min(start, floor), Math.min(start, end - MIN_SWEEP_MS));
    if (previous && start < segment.startMs! && previous.endMs! > start) previous.endMs = Math.max(previous.startMs!, start);
    const ceiling = next ? Math.min(lineEnd, next.endMs! - MIN_SWEEP_MS) : lineEnd;
    end = Math.max(end, Math.min(ceiling, start + MIN_SWEEP_MS));
    if (next && end > segment.endMs! && next.startMs! < end) next.startMs = end;
    segment.startMs = start;
    segment.endMs = end;
  }
  return segments;
}

export function focusLyric(lines: LyricLine[], timeMs: number): number {
  "worklet";
  // Prefer lead vocals; background-only activity still keeps its group in view.
  const lead = lines.findIndex(line => line.text.trim() && lyricActive(line, timeMs));
  return lead >= 0 ? lead : lines.findIndex(line => line.backgroundVocals.some(background => lyricActive(background, timeMs)));
}
