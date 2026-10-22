import { configuredSearchProviders, resolveTrackPlayback, searchServerCatalog, type StreamingProvider } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { searchTrackTitle } from "./catalogRanking";
import { bestPlaylistCopy, sameRecording } from "./searchRanking";

const CONCURRENCY = 3;

// TIDAL search results only name a tier; its manifest reports the real format.
async function withPlayback(track: Track, signal: AbortSignal) {
  return track.provider === "tidal" ? resolveTrackPlayback(track, signal).catch(() => track) : track;
}

async function bestCopy(track: Track, providers: StreamingProvider[], signal: AbortSignal) {
  const query = `${searchTrackTitle(track.name)} ${track.artist}`;
  const searches = providers.map(provider => ({ provider, query }));
  // A title search stops at 20 results, which a popular song's compilations can fill before its
  // album appears. Qobuz answers an ISRC with every release of that recording.
  if (track.isrc && providers.includes("qobuz")) searches.push({ provider: "qobuz", query: track.isrc });
  const pages = await Promise.all(searches.map(search =>
    searchServerCatalog(search.query, search.provider, signal).then(page => page.tracks).catch(() => [] as Track[])));
  const seen = new Set([track.globalId]);
  const matches = pages.flat().filter(candidate => !seen.has(candidate.globalId) && seen.add(candidate.globalId) && sameRecording(track, candidate));
  const resolved = await Promise.all(matches.map(candidate => withPlayback(candidate, signal)));
  return bestPlaylistCopy(await withPlayback(track, signal), resolved);
}

/** Finds the copy each streamed song should be on, across every connected service (see `bestPlaylistCopy`). */
export async function findPlaylistUpgrades(
  tracks: Track[],
  onProgress: (done: number) => void,
  signal: AbortSignal,
): Promise<Map<GlobalTrackId, Track>> {
  const providers = await configuredSearchProviders(signal);
  const upgrades = new Map<GlobalTrackId, Track>();
  let next = 0, done = 0;
  const work = async () => {
    while (next < tracks.length && !signal.aborted) {
      const track = tracks[next++];
      // Local files are the user's own copies and stay as they are.
      if (track.provider !== "local") {
        const best = await bestCopy(track, providers, signal).catch(() => track);
        if (best.globalId !== track.globalId) upgrades.set(track.globalId, best);
      }
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  signal.throwIfAborted();
  return upgrades;
}
