import { trackLyrics } from "../api/server";
import { serverConnectionSignal } from "../api/serverConnection";
import { needsLyricsRetry, type TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import { SearchCache } from "./searchCache";

// One song's lyrics are one object for as long as they are cached. The lyrics view builds a
// song's every letter from them and compares them by identity, so a copy per read would have it
// rebuild all of them each time it asks. Nothing changes lyrics in place.
const lyricsCache = new SearchCache<TrackLyrics>(30 * 60_000, 12, lyrics => lyrics);
type Lookup = { controller: AbortController; signal: AbortSignal; users: number; result: Promise<TrackLyrics> };
const requests = new Map<string, Lookup>();
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

export async function loadLyrics(track: Track, signal?: AbortSignal): Promise<TrackLyrics> {
  signal?.throwIfAborted();
  const key = lyricsKey(track);
  const cached = lyricsCache.get(key);
  if (cached) return cached;

  let pending = requests.get(key);
  if (!pending || pending.signal.aborted) {
    const controller = new AbortController();
    const active = AbortSignal.any([controller.signal, serverConnectionSignal(), AbortSignal.timeout(60_000)]);
    const result = trackLyrics(track, active).then(lyrics => {
      active.throwIfAborted();
      if (!needsLyricsRetry(lyrics)) lyricsCache.set(key, lyrics);
      revision++;
      for (const listener of listeners) listener();
      return lyrics;
    }).finally(() => {
      if (requests.get(key)?.controller === controller) requests.delete(key);
    });
    pending = { controller, signal: active, users: 0, result };
    requests.set(key, pending);
  }

  const lookup = pending;
  lookup.users++;
  try {
    if (!signal) return await lookup.result;
    return await new Promise<TrackLyrics>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      lookup.result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  } finally {
    lookup.users--;
    // React can replace subscribers for the same song in one commit.
    if (lookup.users === 0) queueMicrotask(() => {
      if (lookup.users === 0 && requests.get(key) === lookup) lookup.controller.abort();
    });
  }
}

export async function preloadLyrics(tracks: Track[], signal?: AbortSignal): Promise<void> {
  await Promise.allSettled(tracks.slice(0, 3).map(track => loadLyrics(track, signal)));
}
