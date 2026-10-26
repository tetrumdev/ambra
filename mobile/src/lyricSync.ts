export const MAX_LYRIC_CORRECTION_MS = 60_000;
export type LyricSync = { correctionMs: number; unsynced: boolean };
export const defaultLyricSync: LyricSync = { correctionMs: 0, unsynced: false };

export function parseLyricSync(encoded: string | null): LyricSync {
  try {
    const value = JSON.parse(encoded ?? "null");
    if (!value || typeof value !== "object") return defaultLyricSync;
    return {
      correctionMs: typeof value.correctionMs === "number" && Number.isFinite(value.correctionMs)
        ? Math.max(-MAX_LYRIC_CORRECTION_MS, Math.min(MAX_LYRIC_CORRECTION_MS, Math.round(value.correctionMs))) : 0,
      unsynced: value.unsynced === true,
    };
  } catch { return defaultLyricSync; }
}

export function nudgeLyricSync(current: LyricSync, delta: number): LyricSync {
  return { ...current, correctionMs: Math.max(-MAX_LYRIC_CORRECTION_MS, Math.min(MAX_LYRIC_CORRECTION_MS, current.correctionMs + delta)) };
}

export function lyricPositionMs(view: { positionSeconds: number; playing: boolean; buffering: boolean } | null, ageSeconds: number, duration: number, offsetMs: number) {
  const position = (view?.positionSeconds ?? 0) + (view?.playing && !view.buffering ? Math.max(0, ageSeconds) : 0);
  return Math.max(0, Math.min(duration || Infinity, position)) * 1000 + offsetMs;
}

/** SecureStore keys allow only letters, digits, periods, hyphens and underscores. */
export const lyricSyncStorageKey = (trackId: string) => `ambra.lyricSync.${Array.from(trackId, char => char.codePointAt(0)!.toString(16)).join(".")}`;
