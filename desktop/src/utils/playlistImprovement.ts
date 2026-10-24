import { configuredSearchProviders, resolveTrackPlayback, searchServerCatalog, type StreamingProvider } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { searchTrackTitle } from "./catalogRanking";
import { albumTitleFamily, bestPlaylistCopy, byCodePoint, compareSoundQuality, sameAlbumFamily, sameFormat, sameRecording } from "./searchRanking";

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
  return Promise.all([track, ...matches].map(copy => copy.provider !== "local" && providers.includes(copy.provider) ? withPlayback(copy, signal) : copy));
}

/**
 * New copies for a package's songs, or null to leave it as it is. Bound songs play gaplessly,
 * so they only move together, onto one release from one service in one format, which spares
 * the DAC a sample-rate switch between them. A package already on matching copies moves only
 * for a better-sounding set; one split across formats is reunited on the best matching set.
 */
export function packageCopies(members: Track[], copies: Track[][], restoreAvailability = false): Track[] | null {
  const sets: Track[][] = [];
  for (const lead of copies[0]) {
    const set = [lead];
    for (const [index, options] of copies.slice(1).entries()) {
      const fits = options.filter(copy => copy.provider === lead.provider && sameAlbumFamily(copy, lead) && sameFormat(copy, lead));
      if (!fits.length) break;
      // The member's own copy if it fits, then one on the lead's very release, then the lowest ID.
      const own = fits.find(copy => copy.globalId === members[index + 1].globalId);
      set.push(own ?? fits.sort((a, b) => Number(b.albumId === lead.albumId) - Number(a.albumId === lead.albumId)
        || byCodePoint(a.globalId, b.globalId))[0]);
    }
    if (set.length === members.length) sets.push(set);
  }
  if (!sets.length) return null;
  const unchanged = (set: Track[]) => set.every((copy, index) => copy.globalId === members[index].globalId);
  // The best-sounding set; among equals the current one stays, then the lead with the lowest ID,
  // so the order the services answered in doesn't matter.
  const best = sets.reduce((top, set) => {
    const quality = compareSoundQuality(set[0], top[0]);
    if (quality !== 0) return quality > 0 ? set : top;
    if (unchanged(set) !== unchanged(top)) return unchanged(set) ? set : top;
    return byCodePoint(set[0].globalId, top[0].globalId) < 0 ? set : top;
  });
  if (unchanged(best)) return null;
  const matched = members.every(member => sameFormat(member, members[0]) && member.provider === members[0].provider);
  return restoreAvailability || !matched || compareSoundQuality(best[0], members[0]) > 0 ? best : null;
}

/** Songs counted as one album: its title without edition notes, by its lead artist. */
function albumKey(track: Track) {
  const artist = (track.albumArtists[0]?.name ?? track.artist).toLowerCase().trim();
  const album = albumTitleFamily(track.album);
  return album && artist ? `${album}\n${artist}` : null;
}

/**
 * Moves songs that share an album onto one service, so it plays from one place in one
 * format. A song only moves to a copy that sounds at least as good as the one it would have
 * kept; the service chosen is the one the most songs can be on, then the one most are already on,
 * then by name, so the order songs were found in never decides it.
 * `chosen` is each song's copy so far and is updated in place; `copies` are every copy found.
 */
export function unifyAlbumServices(chosen: Map<GlobalTrackId, Track>, copies: Map<GlobalTrackId, Track[]>) {
  const albums = new Map<string, GlobalTrackId[]>();
  for (const [id, copy] of chosen) {
    const key = albumKey(copy);
    if (key) albums.set(key, [...albums.get(key) ?? [], id]);
  }
  for (const ids of albums.values()) {
    const providers = new Set(ids.map(id => chosen.get(id)!.provider));
    if (ids.length < 2 || providers.size < 2) continue;
    // The copy each song could have on a service: same recording, same album, never worse-sounding.
    // Among equals, the very release its album-mates there are on, then the plainest title.
    const copyOn = (id: GlobalTrackId, provider: Track["provider"]) => {
      const current = chosen.get(id)!;
      if (current.provider === provider) return current;
      const releases = new Set(ids.map(other => chosen.get(other)!).filter(copy => copy.provider === provider).map(copy => copy.albumId));
      return (copies.get(id) ?? [])
        .filter(copy => copy.provider === provider && copy.explicit === current.explicit && sameRecording(current, copy)
          && sameAlbumFamily(copy, current) && compareSoundQuality(copy, current) >= 0)
        .sort((a, b) => compareSoundQuality(b, a) || Number(releases.has(b.albumId)) - Number(releases.has(a.albumId))
          || a.name.length - b.name.length || byCodePoint(a.globalId, b.globalId))[0];
    };
    const score = (provider: Track["provider"]) => [
      ids.filter(id => copyOn(id, provider)).length,
      ids.filter(id => chosen.get(id)!.provider === provider).length,
    ];
    const target = [...providers].reduce((best, provider) => {
      const [a, b] = [score(provider), score(best)];
      const order = a[0] - b[0] || a[1] - b[1] || byCodePoint(best, provider);
      return order > 0 ? provider : best;
    });
    for (const id of ids) {
      const copy = copyOn(id, target);
      if (copy) chosen.set(id, copy);
    }
  }
}

/**
 * Finds the copy each streamed song should be on, across every connected service: a song alone
 * follows `bestPlaylistCopy`, and a package's songs move together (`packageCopies`). Songs from
 * one album then gather on one service (`unifyAlbumServices`).
 */
export async function findPlaylistUpgrades(
  tracks: Track[],
  onProgress: (done: number) => void,
  signal: AbortSignal,
  packages: GlobalTrackId[][] = [],
): Promise<Map<GlobalTrackId, Track>> {
  const providers = await configuredSearchProviders(signal);
  const available = (track: Track) => track.provider === "local" || providers.includes(track.provider);
  const results: (Track[] | undefined)[] = [];
  let next = 0, done = 0;
  const work = async () => {
    while (next < tracks.length && !signal.aborted) {
      const index = next++;
      const track = tracks[index];
      // Local files are the user's own copies and stay as they are.
      if (track.provider !== "local") results[index] = await copiesOf(track, providers, signal).catch(() => [track]);
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  signal.throwIfAborted();
  // Kept in playlist order, not the order searches finished in, which varies run to run.
  const found = new Map<GlobalTrackId, Track[]>();
  results.forEach((copies, index) => { if (copies) found.set(tracks[index].globalId, copies); });

  const upgrades = new Map<GlobalTrackId, Track>();
  const byId = new Map(tracks.map(track => [track.globalId, track]));
  const packaged = new Set<GlobalTrackId>();
  for (const pack of packages) {
    const members = pack.flatMap(id => byId.get(id) ?? []);
    for (const member of members) packaged.add(member.globalId);
    // A package with a local file or a missing song can't move as one.
    if (members.length !== pack.length || members.some(member => !found.has(member.globalId))) continue;
    const restoreAvailability = members.some(member => !available(member));
    const moved = packageCopies(members, members.map(member => found.get(member.globalId)!.filter(available)), restoreAvailability);
    moved?.forEach((copy, index) => { if (copy.globalId !== members[index].globalId) upgrades.set(members[index].globalId, copy); });
  }
  const chosen = new Map<GlobalTrackId, Track>();
  for (const [id, [current, ...candidates]] of found) {
    if (packaged.has(id)) continue;
    const copy = bestPlaylistCopy(current, candidates.filter(available), !available(current));
    if (available(copy)) chosen.set(id, copy);
  }
  unifyAlbumServices(chosen, new Map([...found].map(([id, copies]) => [id, copies.filter(available)])));
  for (const [id, copy] of chosen) {
    if (copy.globalId !== id) upgrades.set(id, copy);
  }
  return upgrades;
}
