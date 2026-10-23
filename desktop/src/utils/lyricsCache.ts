import { trackLyrics } from "../api/server";
import { needsLyricsRetry, type TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import { SearchCache } from "./searchCache";

const lyricsCache = new SearchCache<TrackLyrics>(30 * 60_000, 12);
const requests = new Map<string, Promise<TrackLyrics>>();
const listeners = new Set<() => void>();
let revision = 0;

export function subscribeLyrics(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function lyricsRevision(): number {
  return revision;
}

/** Everything a lyrics lookup depends on; a change to any of it is a different lookup. */
export function lyricsKey(track: Track): string {
  return JSON.stringify([
    track.globalId,
    track.name,
    track.artist,
    track.album,
    track.durationSeconds,
    track.isrc,
    track.version,
    track.provider,
    track.providerTrackId,
  ]);
}

export function cachedLyrics(track: Track): TrackLyrics | undefined {
  return lyricsCache.get(lyricsKey(track));
}

export function loadLyrics(track: Track): Promise<TrackLyrics> {
  const key = lyricsKey(track);
  const cached = lyricsCache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = requests.get(key);
  if (pending) return pending;

  // A view unmount must not cancel a request shared with queue preloading.
  // Bound its lifetime independently, including the API's automatic retry.
  const request = trackLyrics(track, AbortSignal.timeout(60_000))
    .then((lyrics) => {
      if (!needsLyricsRetry(lyrics))
        lyricsCache.set(key, lyrics);
      revision++;
      for (const listener of listeners) listener();
      return lyrics;
    })
    .finally(() => requests.delete(key));
  requests.set(key, request);
  return request;
}

export async function preloadLyrics(tracks: Track[]): Promise<void> {
  await Promise.allSettled(tracks.slice(0, 3).map(loadLyrics));
}
