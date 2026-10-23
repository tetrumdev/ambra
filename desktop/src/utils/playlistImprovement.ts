import { configuredSearchProviders, resolveTrackPlayback, searchServerCatalog, type StreamingProvider } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { searchTrackTitle } from "./catalogRanking";
import { bestPlaylistCopy, compareSoundQuality, sameAlbumFamily, sameFormat, sameRecording } from "./searchRanking";

const CONCURRENCY = 3;

// TIDAL search results only name a tier; its manifest reports the real format.
async function withPlayback(track: Track, signal: AbortSignal) {
  return track.provider === "tidal" ? resolveTrackPlayback(track, signal).catch(() => track) : track;
}

/** The song as it is, then every other copy of its recording found on the connected services. */
async function copiesOf(track: Track, providers: StreamingProvider[], signal: AbortSignal): Promise<Track[]> {
  const query = `${searchTrackTitle(track.name)} ${track.artist}`;
  const searches = providers.map(provider => ({ provider, query }));
  // A title search stops at 20 results, which a popular song's compilations can fill before its
  // album appears. Qobuz answers an ISRC with every release of that recording.
  if (track.isrc && providers.includes("qobuz")) searches.push({ provider: "qobuz", query: track.isrc });
  const pages = await Promise.all(searches.map(search =>
    searchServerCatalog(search.query, search.provider, signal).then(page => page.tracks).catch(() => [] as Track[])));
  const seen = new Set([track.globalId]);
  const matches = pages.flat().filter(candidate => !seen.has(candidate.globalId) && seen.add(candidate.globalId)
    && candidate.provider !== "local" && candidate.explicit === track.explicit && sameRecording(track, candidate));
  return Promise.all([track, ...matches].map(copy => withPlayback(copy, signal)));
}

/**
 * New copies for a package's songs, or null to leave it as it is. Bound songs play gaplessly,
 * so they only move together, onto one release from one service in one format, which spares
 * the DAC a sample-rate switch between them. A package already on matching copies moves only
 * for a better-sounding set; one split across formats is reunited on the best matching set.
 */
export function packageCopies(members: Track[], copies: Track[][]): Track[] | null {
  const sets: Track[][] = [];
  for (const lead of copies[0]) {
    const set = [lead];
    for (const [index, options] of copies.slice(1).entries()) {
      const fits = options.filter(copy => copy.provider === lead.provider && sameAlbumFamily(copy, lead) && sameFormat(copy, lead));
      if (!fits.length) break;
      set.push(fits.find(copy => copy.globalId === members[index + 1].globalId) ?? fits[0]);
    }
    if (set.length === members.length) sets.push(set);
  }
  if (!sets.length) return null;
  const unchanged = (set: Track[]) => set.every((copy, index) => copy.globalId === members[index].globalId);
  // The best-sounding set; among equals the current one stays, then the earliest found.
  const best = sets.reduce((top, set) => {
    const quality = compareSoundQuality(set[0], top[0]);
    return quality > 0 || (quality === 0 && unchanged(set) && !unchanged(top)) ? set : top;
  });
  if (unchanged(best)) return null;
  const matched = members.every(member => sameFormat(member, members[0]) && member.provider === members[0].provider);
  return !matched || compareSoundQuality(best[0], members[0]) > 0 ? best : null;
}

/**
 * Finds the copy each streamed song should be on, across every connected service: a song alone
 * follows `bestPlaylistCopy`, and a package's songs move together (`packageCopies`).
 */
export async function findPlaylistUpgrades(
  tracks: Track[],
  onProgress: (done: number) => void,
  signal: AbortSignal,
  packages: GlobalTrackId[][] = [],
): Promise<Map<GlobalTrackId, Track>> {
  const providers = await configuredSearchProviders(signal);
  const found = new Map<GlobalTrackId, Track[]>();
  let next = 0, done = 0;
  const work = async () => {
    while (next < tracks.length && !signal.aborted) {
      const track = tracks[next++];
      // Local files are the user's own copies and stay as they are.
      if (track.provider !== "local") found.set(track.globalId, await copiesOf(track, providers, signal).catch(() => [track]));
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  signal.throwIfAborted();

  const upgrades = new Map<GlobalTrackId, Track>();
  const byId = new Map(tracks.map(track => [track.globalId, track]));
  const packaged = new Set<GlobalTrackId>();
  for (const pack of packages) {
    const members = pack.flatMap(id => byId.get(id) ?? []);
    for (const member of members) packaged.add(member.globalId);
    // A package with a local file or a missing song can't move as one.
    if (members.length !== pack.length || members.some(member => !found.has(member.globalId))) continue;
    const moved = packageCopies(members, members.map(member => found.get(member.globalId)!));
    moved?.forEach((copy, index) => { if (copy.globalId !== members[index].globalId) upgrades.set(members[index].globalId, copy); });
  }
  for (const [id, [current, ...candidates]] of found) {
    if (packaged.has(id)) continue;
    const best = bestPlaylistCopy(current, candidates);
    if (best.globalId !== id) upgrades.set(id, best);
  }
  return upgrades;
}
