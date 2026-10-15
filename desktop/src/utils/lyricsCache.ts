import { trackLyrics } from "../api/server";
import type { TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import { SearchCache } from "./searchCache";

const lyricsCache = new SearchCache<TrackLyrics>(30 * 60_000, 12);
const requests = new Map<string, Promise<TrackLyrics>>();

function lyricsKey(track: Track): string {
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
  const request = trackLyrics(track, AbortSignal.timeout(55_000))
    .then((lyrics) => {
      if (lyrics.status !== "unavailable" || lyrics.failedProviders.length === 0)
        lyricsCache.set(key, lyrics);
      return lyrics;
    })
    .finally(() => requests.delete(key));
  requests.set(key, request);
  return request;
}

export async function preloadLyrics(tracks: Track[]): Promise<void> {
  await Promise.allSettled(tracks.slice(0, 3).map(loadLyrics));
}
