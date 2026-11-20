import { trackLyrics, vocalCurve } from "../api/server";
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

/** `prefetch` loads ahead of playback, so the server analyzes the song's vocals after any playing now. */
export async function loadLyrics(track: Track, signal?: AbortSignal, prefetch = false): Promise<TrackLyrics> {
  signal?.throwIfAborted();
  const key = lyricsKey(track);
  const cached = lyricsCache.get(key);
  if (cached) {
    // Loaded ahead of playback and now wanted for real: its analysis moves ahead of songs to come.
    if (!prefetch) watched.get(key)?.foreground();
    return cached;
  }

  let pending = requests.get(key);
  if (!pending || pending.signal.aborted) {
    const controller = new AbortController();
    const active = AbortSignal.any([controller.signal, serverConnectionSignal(), AbortSignal.timeout(60_000)]);
    const result = trackLyrics(track, active, prefetch).then(lyrics => {
      active.throwIfAborted();
      if (!needsLyricsRetry(lyrics)) lyricsCache.set(key, lyrics);
      if (lyrics.vocalTiming === "pending") watchVocalTiming(track, key, prefetch);
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
  await Promise.allSettled(tracks.slice(0, 3).map(track => loadLyrics(track, signal, true)));
}

const VOCAL_POLL_MS = 5_000;
/** A song the server is still analyzing is checked on for at most this long. */
const VOCAL_WATCH_MS = 30 * 60_000;
const watched = new Map<string, { foreground: () => void }>();

/**
 * While the server analyzes a song's vocals, checks back until it is done, then loads the
 * lyrics again so their endings come from the vocals. Songs left the cache are dropped.
 * A song loaded ahead of playback is checked on as one: asking for it as if it were playing
 * would move it ahead of the song that is, and cut that song's analysis off.
 */
function watchVocalTiming(track: Track, key: string, prefetch: boolean) {
  const existing = watched.get(key);
  if (existing) {
    if (!prefetch) existing.foreground();
    return;
  }
  let ahead = prefetch;
  watched.set(key, { foreground: () => { ahead = false; } });
  const until = Date.now() + VOCAL_WATCH_MS;
  const check = async () => {
    if (Date.now() > until || !lyricsCache.get(key)) return watched.delete(key);
    let curve: Awaited<ReturnType<typeof vocalCurve>> = "pending";
    try {
      curve = await vocalCurve(track, ahead);
    } catch {
      // The server may be briefly unreachable; check again later.
    }
    if (curve === "pending") return void setTimeout(check, VOCAL_POLL_MS);
    watched.delete(key);
    if (curve === null) return;
    lyricsCache.delete(key);
    void loadLyrics(track).catch(() => undefined);
  };
  setTimeout(check, VOCAL_POLL_MS);
}
