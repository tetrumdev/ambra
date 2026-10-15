import type { LyricLine, LyricSegment } from "../types/lyrics";

export function lyricActive(timing: Pick<LyricSegment, "startMs" | "endMs">, timeMs: number): boolean {
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

export function focusLyric(lines: LyricLine[], timeMs: number): number {
  // Prefer lead vocals; background-only activity still keeps its group in view.
  const lead = lines.findIndex(line => line.text.trim() && lyricActive(line, timeMs));
  return lead >= 0 ? lead : lines.findIndex(line => line.backgroundVocals.some(background => lyricActive(background, timeMs)));
}
