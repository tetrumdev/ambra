import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Track } from "../types/music";
import { getPersistentItem, setPersistentItem } from "../utils/persistentStorage";
import { isSavedTrack } from "../utils/playlistStorage";
import { parseQueueSnapshot } from "../utils/queueStorage";

const storageKey = "ambra.listening-history.v1";
/** `playCount` started being kept after listening history did; older entries count one play. */
export type ListeningEntry = { track: Track; lastPlayedAt: number; playCount?: number };
export type TrackPlayStats = { plays: number; lastPlayedAt: number };

function loadHistory(): ListeningEntry[] {
  const raw = getPersistentItem(storageKey);
  if (raw !== null) {
    const saved = JSON.parse(raw);
    const ids = new Set<string>();
    if (saved?.version !== 1 || !Array.isArray(saved.entries)
      || !saved.entries.every((entry: ListeningEntry) => entry && isSavedTrack(entry.track)
        && entry.track.globalId.length > 0 && !ids.has(entry.track.globalId) && ids.add(entry.track.globalId)
        && Number.isSafeInteger(entry.lastPlayedAt) && entry.lastPlayedAt > 0 && entry.lastPlayedAt <= 8.64e15
        && (entry.playCount === undefined || (Number.isSafeInteger(entry.playCount) && entry.playCount > 0)))) {
      throw new Error("Invalid listening history");
    }
    return saved.entries;
  }

  // Preserve the latest known plays from the server's existing queue history.
  const queue = parseQueueSnapshot(getPersistentItem("ambra.queue.v1"));
  const tracks = new Map(queue?.tracks?.map(track => [track.globalId, track]));
  const entries = new Map<string, ListeningEntry>();
  for (const item of queue?.history ?? []) {
    const track = tracks.get(item.globalTrackId);
    const lastPlayedAt = Date.parse(item.playedAt);
    if (track && track.globalId && lastPlayedAt > 0 && Number.isSafeInteger(lastPlayedAt)
      && lastPlayedAt > (entries.get(track.globalId)?.lastPlayedAt ?? 0)) {
      entries.set(track.globalId, { track, lastPlayedAt });
    }
  }
  return [...entries.values()];
}

export function useListeningHistory() {
  const [initial] = useState(() => {
    try {
      return { entries: loadHistory(), error: null };
    } catch {
      return { entries: [] as ListeningEntry[], error: "Listening history could not be loaded. Saved history has been left untouched." };
    }
  });
  const [entries, setEntries] = useState(initial.entries);
  const current = useRef(entries);
  const [error, setError] = useState(initial.error);

  const save = useCallback((next: ListeningEntry[]) => {
    if (initial.error) return;
    try {
      setPersistentItem(storageKey, JSON.stringify({ version: 1, entries: next }));
      current.current = next;
      setEntries(next);
      setError(null);
    } catch {
      setError("Could not save listening history. Check available device storage and retry playback.");
    }
  }, [initial.error]);

  useEffect(() => {
    if (getPersistentItem(storageKey) === null && initial.entries.length > 0) save(initial.entries);
  }, [initial.entries, save]);

  const recordPlay = useCallback((track: Track) => {
    const previous = current.current.find(entry => entry.track.globalId === track.globalId);
    save([
      { track, lastPlayedAt: Date.now(), playCount: (previous?.playCount ?? (previous ? 1 : 0)) + 1 },
      ...current.current.filter(entry => entry !== previous),
    ]);
  }, [save]);
  const tracks = useMemo(() => entries.map(entry => entry.track), [entries]);
  const stats = useMemo(() => new Map<string, TrackPlayStats>(entries.map(entry => [
    entry.track.globalId, { plays: entry.playCount ?? 1, lastPlayedAt: entry.lastPlayedAt },
  ])), [entries]);
  return { entries, tracks, stats, error, recordPlay };
}
