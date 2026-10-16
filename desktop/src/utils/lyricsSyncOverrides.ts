import { getPersistentItem, setPersistentItem } from "./persistentStorage";

/** A listener's own timing choices for one track, kept across sessions. */
export type LyricSyncOverride = {
  /** Milliseconds added to the lyrics' own offset; replaces automatic detection. */
  correctionMs?: number;
  /** Show the lyrics as plain text even though they are timed. */
  unsynced?: boolean;
};

const storageKey = "ambra.lyrics-sync.v1";
const MAX_TRACKS = 2000;
export const MAX_CORRECTION_MS = 60_000;

function readOverrides(): Record<string, LyricSyncOverride> {
  try {
    const value: unknown = JSON.parse(getPersistentItem(storageKey) ?? "{}");
    if (typeof value !== "object" || value === null) return {};
    const overrides: Record<string, LyricSyncOverride> = {};
    for (const [trackId, entry] of Object.entries(value)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { correctionMs, unsynced } = entry as Record<string, unknown>;
      const override: LyricSyncOverride = {};
      if (typeof correctionMs === "number" && Number.isFinite(correctionMs)
        && Math.abs(correctionMs) <= MAX_CORRECTION_MS) override.correctionMs = correctionMs;
      if (unsynced === true) override.unsynced = true;
      if (Object.keys(override).length) overrides[trackId] = override;
    }
    return overrides;
  } catch {
    return {};
  }
}

export function lyricSyncOverride(trackId: string): LyricSyncOverride | undefined {
  return readOverrides()[trackId];
}

export function saveLyricSyncOverride(trackId: string, override: LyricSyncOverride | undefined) {
  const overrides = readOverrides();
  // Reinserting keeps the most recently edited tracks at the end.
  delete overrides[trackId];
  if (override && (override.correctionMs !== undefined || override.unsynced)) overrides[trackId] = override;
  const trackIds = Object.keys(overrides);
  for (const stale of trackIds.slice(0, Math.max(0, trackIds.length - MAX_TRACKS))) delete overrides[stale];
  try {
    setPersistentItem(storageKey, JSON.stringify(overrides));
  } catch (error) {
    console.warn("Could not save lyric timing:", error);
  }
}
