import { configuredSearchProviders, resolveTrackPlayback, searchServerCatalog, type StreamingProvider } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { searchTrackTitle } from "./catalogRanking";
import { bestQualityRecording, sameRecording } from "./searchRanking";

const CONCURRENCY = 3;

// TIDAL search results only name a tier; its manifest reports the real format.
async function withPlayback(track: Track, signal: AbortSignal) {
  return track.provider === "tidal" ? resolveTrackPlayback(track, signal).catch(() => track) : track;
}

async function bestCopy(track: Track, providers: StreamingProvider[], signal: AbortSignal) {
  const query = `${searchTrackTitle(track.name)} ${track.artist}`;
  const pages = await Promise.all(providers.map(provider =>
    searchServerCatalog(query, provider, signal).then(page => page.tracks).catch(() => [] as Track[])));
  const matches = pages.flat().filter(candidate => candidate.globalId !== track.globalId && sameRecording(track, candidate));
  const resolved = await Promise.all(matches.map(candidate => withPlayback(candidate, signal)));
  return bestQualityRecording(await withPlayback(track, signal), resolved);
}

/** Finds a better-sounding copy of each streamed song across every connected service. */
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
