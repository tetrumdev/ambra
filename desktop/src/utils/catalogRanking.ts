import { artistCredits, fold, foldTokens, matchEntry, matchName, variantFactor } from "./searchMatch";
import { serviceRank } from "./servicePreference";
import type { CatalogArtist, CatalogAlbum } from "../api/server";

/** A value derived from an entry, worked out once per entry object (entries aren't changed in place). */
function derived<T extends object, V>(compute: (item: T) => V) {
  const cache = new WeakMap<T, V>();
  return (item: T) => {
    if (cache.has(item)) return cache.get(item)!;
    const value = compute(item);
    cache.set(item, value);
    return value;
  };
}

// How well each entry explains a query, kept for the last few queries: every answer and
// background lookup ranks the same entries again. One store per query and kind of fit.
const fitStores = new Map<string, WeakMap<object, unknown>>();
function remembered<V>(kind: string, entry: object, query: string, fit: () => V): V {
  const key = `${kind}|${query}`;
  let store = fitStores.get(key);
  if (!store) {
    store = new WeakMap();
    fitStores.set(key, store);
    if (fitStores.size > 16) fitStores.delete(fitStores.keys().next().value!);
  }
  if (store.has(entry)) return store.get(entry) as V;
  const value = fit();
  store.set(entry, value);
  return value;
}

export function searchText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function distance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    previous = row;
  }
  return previous[b.length];
}
/** 5: the same text. 4: every query word is in the value. 3: the value contains the query. 2: close spellings. */
export function textRelevance(value: string, query: string): number {
  // "&" and "and" are one word some services write and others leave out.
  const plain = (text: string) => {
    const words = foldTokens(text);
    const kept = words.filter(word => word !== "and");
    return kept.length ? kept : words;
  };
  const words = plain(value), terms = plain(query);
  if (!words.length || !terms.length) return 0;
  const a = words.join(" "), b = terms.join(" ");
  if (a === b || words.join("") === terms.join("")) return 5;
  if (terms.every(term => words.includes(term))) return 4;
  if (a.includes(b)) return 3;
  if (terms.every(term => words.some(word => term.length >= 4 && distance(word, term) <= (term.length >= 8 ? 2 : 1)))) return 2;
  return 0;
}
// Retrieval variants are deliberately bounded; fuzzy ranking never changes entity identity.
export function fallbackQuery(query: string, hasResults: boolean): string | null {
  if (/\band\b/i.test(query)) return query.replace(/\band\b/gi, "&");
  const normalized = searchText(query);
  return !hasResults && normalized !== query.toLowerCase().trim() ? normalized : null;
}
type TrackCredit = { name: string; artist: string; album?: string };
export function searchTrackTitle(name: string) {
  // Edition labels do not change song identity; performance labels do.
  return name.replace(/\s*[([][^)\]]*\bremaster(?:ed)?\b[^)\]]*[)\]]/gi, "")
    .replace(/\s+[-–—]\s+(?:(?:19|20)\d{2}\s+)?remaster(?:ed)?(?:\s+(?:19|20)\d{2})?$/i, "").trim();
}
const songMatch = (track: TrackCredit, query: string) => matchEntry({ title: searchTrackTitle(track.name), artists: [track.artist] }, query);

/** The first song, when the query names its whole title and nothing the song doesn't explain. */
export function leadingSong(query: string, tracks: TrackCredit[]) {
  const first = tracks[0];
  if (!first) return null;
  const match = songMatch(first, query);
  return match.coverage >= 0.99 && match.title >= 0.99 ? first : null;
}

export function matchingTrackArtist(query: string, tracks: TrackCredit[]): string | null {
  const names = new Set(tracks.filter(track => {
    const match = songMatch(track, query);
    return match.coverage >= 0.99 && match.title >= 0.99 && match.artist >= 0.99;
  }).map(track => track.artist));
  // Only infer a credit when the song-and-artist match is unambiguous.
  return names.size === 1 ? [...names][0] : null;
}

/** An album at least this good belongs to the query; the rest is a service's filler. */
const RELATED = 0.55;
/** The same for an artist: a name is short, so one near-miss word must not be enough. */
const RELATED_ARTIST = 0.65;
/** One act however a service spells it: "4hero" and "4 Hero", "C.L. Smooth" and "CL Smooth". */
const artistKeys = new Map<string, string>();
const artistKey = (name: string) => {
  let key = artistKeys.get(name);
  if (key === undefined) {
    key = fold(name).replace(/ /g, "");
    if (artistKeys.size > 4000) artistKeys.clear();
    artistKeys.set(name, key);
  }
  return key;
};

/**
 * Artists the query names, and those credited on the songs it names; best first. A service's
 * search pads its artists with loosely related acts: those are left out whenever anything
 * does match. `tracks` are the songs the query plainly names; with none, and no artist
 * matching, the query wasn't understood and the services' own artists are kept. With
 * `songIntent` (the query is after a song), the named song's artist leads the acts merely named
 * like the song ("Bohemian Rhapsody", a cover act, before Queen).
 */
export function rankArtists(values: CatalogArtist[], query: string, tracks: TrackCredit[] = [], songIntent = false) {
  const credit = matchingTrackArtist(query, tracks) ?? leadingSong(query, tracks)?.artist;
  const credited = credit ? artistCredits([credit]) : new Set<string>();
  // Whoever the leading songs are by, when the query names them even in part: "kendrick lam"
  // is Kendrick Lamar being typed, whatever lesser-known act is spelled exactly that.
  const performers = new Set(tracks.slice(0, 3).filter(track => songMatch(track, query).artist >= 0.5)
    .flatMap(track => [...artistCredits([track.artist])]));
  const scores = new Map<CatalogArtist, { score: number; coverage: number; spelled: boolean }>();
  const score = (artist: CatalogArtist) => {
    const { named, coverage, exact } = remembered("artistName", artist, query, () => matchName(artist.name, query));
    // The whole name within a longer query, or a query that is the start of a name.
    const typed = Math.max(named * (0.6 + 0.4 * coverage), coverage * (0.5 + 0.5 * named));
    const name = fold(artist.name);
    const performs = performers.has(name);
    const services = (artist.sources ?? [artist]).length;
    return {
      score: (performs || (songIntent && credited.has(name)) ? Math.max(typed, 0.9) + 0.15 : credited.has(name) ? Math.max(typed, 0.9) : typed) + 0.02 * (services - 1),
      // Credited artists answer the query through their song, however little of it names them.
      coverage: performs || credited.has(name) ? 1 : coverage,
      spelled: exact || performs || credited.has(name),
    };
  };
  // Equal names within one service can be different artists. Only collapse across services,
  // keeping each service's entry so the artist page can gather releases from all of them.
  const result: CatalogArtist[] = [];
  for (const item of values) {
    if (result.some(other => other.sources?.some(source => source.id === item.id) ?? other.id === item.id)) continue;
    const index = result.findIndex(other => artistKey(other.name) === artistKey(item.name)
      && !(other.sources ?? [other]).some(source => source.provider === item.provider));
    if (index < 0) { result.push(item); continue; }
    result[index] = { ...result[index], sources: [...result[index].sources ?? [result[index]], item] };
  }
  for (const artist of result) scores.set(artist, score(artist));
  result.sort((a, b) => scores.get(b)!.score - scores.get(a)!.score);
  let related = result.filter(artist => scores.get(artist)!.score >= RELATED_ARTIST);
  // With the name spelled out, near misses ("Peter Rock" for "pete rock") are not it; and when
  // a name holds the whole query, one holding a word of it ("Rock") is not it either.
  for (const kept of [(artist: CatalogArtist) => scores.get(artist)!.spelled, (artist: CatalogArtist) => scores.get(artist)!.coverage >= 0.99]) {
    if (related.some(kept)) related = related.filter(kept);
  }
  const ranked = related.length || tracks.length ? related : result;
  // Another act of a name already shown ("Kendrick Lamar" twice on one service, "Radiohead -")
  // follows every other name: still there under "Show all", but the first cards are all different.
  const first = new Set<string>();
  const repeated = (artist: CatalogArtist) => {
    const key = artistKey(artist.name);
    if (first.has(key)) return true;
    first.add(key);
    return false;
  };
  const flags = ranked.map(repeated);
  return [...ranked.filter((_, index) => !flags[index]), ...ranked.filter((_, index) => flags[index])];
}

// Labels that mark another pressing of the same album rather than a different record.
// Anything else in brackets (Live, Acoustic, Blue Album…) keeps editions apart.
const editionWords = new Set(["remaster", "remastered", "remasters", "deluxe", "super", "expanded", "anniversary", "edition", "special", "collector", "collectors", "bonus", "track", "tracks", "version", "reissue", "legacy", "definitive", "explicit", "digital", "the", "and", "s"]);
function editionLabel(text: string) {
  const words = searchText(text).split(" ").filter(Boolean);
  return words.length > 0 && words.every(word => editionWords.has(word) || /^\d+(st|nd|rd|th)?$/.test(word));
}
/** Remove edition annotations while retaining titles such as 1989 and Live at Wembley. */
export function albumBaseTitle(title: string) {
  return title
    .replace(/\s*[([]([^)\]]*)[)\]]/g, (whole, label: string) => editionLabel(label) ? "" : whole)
    .replace(/\s+[-–—:]\s+([^-–—:]+)$/, (whole, label: string) => editionLabel(label) ? "" : whole);
}
/** The album an edition belongs to: its title and version without remaster or deluxe labels. */
export const albumIdentity = derived((album: CatalogAlbum) => {
  const version = album.version && !editionLabel(album.version) ? album.version : "";
  // Some services repeat the version in the title ("… (Instrumental)"); others keep it separate.
  const title = searchText(albumBaseTitle(album.title));
  const bare = version && title.endsWith(` ${searchText(version)}`) ? title.slice(0, -searchText(version).length - 1) : title;
  return `${bare}|${searchText(version)}`;
});

/** Everyone credited on an album, by name; services list collaborators differently. */
function albumArtistNames(album: CatalogAlbum) {
  const names = album.artists?.length
    ? album.artists.map(artist => artist.name)
    : album.artist.split(/\s*(?:,|&|\band\b|\bx\b|\bwith\b|\bfeat\.?|\bft\.?)\s*/i);
  return new Set(names.map(searchText).filter(Boolean));
}

/**
 * Whether two catalog albums are one album: the same title and version once edition labels
 * are set aside, credited to at least one of the same artists. "Her Loss" by Drake and by
 * Drake, 21 Savage is one album; two artists' "Greatest Hits" are not.
 */
export function sameAlbum(left: CatalogAlbum, right: CatalogAlbum) {
  if (albumIdentity(left) !== albumIdentity(right)) return false;
  const theirs = albumCredits(right);
  return [...albumCredits(left)].some(name => theirs.has(name));
}
// One service credits "Pete Rock & C.L. Smooth" as an act, another as two artists.
const albumCredits = derived((album: CatalogAlbum) => artistCredits(album.artists?.length ? album.artists.map(artist => artist.name) : [album.artist]));

// A choice is filed under each credited artist, so a service listing collaborators differently still finds it.
const preferenceKeys = (album: CatalogAlbum) => [...albumArtistNames(album)].map(name => `${name}|${albumIdentity(album)}`);
const losslessProviders = new Set(["qobuz", "tidal", "local"]);
/**
 * Higher is better: explicit, then bit depth and sample rate, with lossless services assumed CD
 * quality, then the service songs are settled by too (`serviceRank`), so equal copies of an
 * album and of its songs come from one service.
 */
function editionQuality(album: CatalogAlbum): number[] {
  const lossless = losslessProviders.has(album.provider);
  return [Number(album.explicit ?? false), album.maximumBitDepth ?? (lossless ? 16 : 0), album.maximumSamplingRateKHz ?? (lossless ? 44.1 : 0), serviceRank(album.provider)];
}

const compareScores = (a: number[], b: number[]) => a.map((value, index) => value - b[index]).find(difference => difference !== 0) ?? 0;

/**
 * Compares two copies of an album by `editionQuality`, after `lead`. Some services' search leaves
 * out the sample rate (TIDAL's gives only the bit depth); a rate is then compared only when both
 * copies state one, rather than an unstated rate losing to any stated one.
 */
function compareEditions(left: CatalogAlbum, right: CatalogAlbum, lead: [number, number] = [0, 0]) {
  const a = [lead[0], ...editionQuality(left)], b = [lead[1], ...editionQuality(right)];
  const rate = 3;
  if (left.maximumSamplingRateKHz == null || right.maximumSamplingRateKHz == null) a[rate] = b[rate] = 0;
  return compareScores(a, b);
}

// The version the listener picked for each album, by album identity; it opens instead of the
// best-sounding copy wherever the album's editions are gathered into one.
const PREFERRED_VERSIONS_KEY = "ambra.album-versions.v1";

function preferredVersions(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(PREFERRED_VERSIONS_KEY) ?? "{}");
    return typeof value === "object" && value !== null ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** Remembers which copy of an album to open from now on. */
export function preferAlbumVersion(album: CatalogAlbum) {
  try {
    const choice = `${album.provider}:${album.id}`;
    globalThis.localStorage?.setItem(PREFERRED_VERSIONS_KEY, JSON.stringify({
      ...preferredVersions(),
      ...Object.fromEntries(preferenceKeys(album).map(key => [key, choice])),
    }));
  } catch {
    // Without storage the choice lasts until the album is gathered again.
  }
}

/** Whether this copy is the one the listener picked for its album. */
export function isPreferredAlbumVersion(album: CatalogAlbum) {
  const preferred = preferredVersions();
  return preferenceKeys(album).some(key => preferred[key] === `${album.provider}:${album.id}`);
}

/** Keep the individual catalog copies available after choosing a representative, which a picked version overrides. */
function withAlbumVersions(album: CatalogAlbum, copies: CatalogAlbum[]): CatalogAlbum {
  const versions = new Map<string, CatalogAlbum>();
  for (const copy of copies.flatMap(copy => [copy, ...(copy.versions ?? [])])) {
    const { versions: _, ...source } = copy;
    versions.set(`${source.provider}:${source.id}`, source);
  }
  const chosen = preferredVersions();
  const preferred = preferenceKeys(album).map(key => versions.get(chosen[key] ?? "")).find(Boolean);
  return { ...(preferred ?? album), versions: [...versions.values()] };
}

/** One copy per album: every edition and service collapses into its best-sounding copy; earlier wins ties. */
export function bestEditions(albums: CatalogAlbum[]): CatalogAlbum[] {
  const best: CatalogAlbum[] = [];
  for (const album of albums) {
    const index = best.findIndex(current => [current, ...(current.versions ?? [])].some(copy => sameAlbum(copy, album)));
    const current = index < 0 ? undefined : best[index];
    const representative = !current || compareEditions(album, current) > 0 ? album : current;
    const merged = withAlbumVersions(representative, current ? [current, album] : [album]);
    if (index < 0) best.push(merged);
    else best[index] = merged;
  }
  return best;
}

/**
 * Albums the query names, by the artist it names, or holding the song it names; best first,
 * one entry per album. Like `rankArtists`, a service's unrelated albums are left out whenever
 * anything matches, and kept when the query wasn't understood at all. With `songIntent` (the
 * query is after a song), the leading song's own release comes first, and other artists'
 * releases named like the song (covers, mostly) follow that artist's.
 */
export function rankAlbums(values: CatalogAlbum[], query: string, tracks: TrackCredit[] = [], songIntent = false) {
  const songs = tracks.slice(0, 3).map(track => ({
    album: fold(albumBaseTitle(track.album ?? "")), artists: artistCredits([track.artist]),
  }));
  const score = (album: CatalogAlbum) => {
    const entry = { title: album.title, notes: album.version ? [album.version] : [],
      artists: album.artists?.length ? album.artists.map(artist => artist.name) : [album.artist] };
    const typed = remembered("albumTyped", album, query, () => matchEntry(entry, query).score * variantFactor(entry, query));
    // The release a named song is on, most of all the leading song's.
    const title = fold(albumBaseTitle(album.title));
    const names = artistCredits(entry.artists);
    const held = songs.findIndex(song => song.album && song.album === title
      && (names.has("various artists") || names.has("various") || [...song.artists].some(name => names.has(name))));
    if (songIntent && songs[0]) {
      if (held === 0) return Math.max(typed, 1.05);
      if (![...songs[0].artists].some(name => names.has(name))) return (held < 0 ? typed : Math.max(typed, 0.85 - 0.05 * held)) * 0.7;
    }
    return held < 0 ? typed : Math.max(typed, 0.85 - 0.05 * held);
  };
  // An edition the query names (deluxe, 2011 remaster…) wins over a better-sounding one.
  const terms = searchText(query).split(" ").filter(term => editionWords.has(term) || /^\d{4}$/.test(term));
  const asked = (album: CatalogAlbum) => terms.filter(term => searchText(`${album.title} ${album.version ?? ""}`).split(" ").includes(term)).length;
  // Every edition and service of one album collapses into its best copy; earlier results win ties.
  const groups: { album: CatalogAlbum; copies: CatalogAlbum[]; fusion: number; providers: Set<string>; score: number }[] = [];
  const ranks = new Map<string, number>();
  const seen = new Set<string>();
  for (const item of values) {
    const key = `${item.provider}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let group = groups.find(group => group.copies.some(copy => sameAlbum(copy, item)));
    if (!group) { group = {album: item, copies: [], fusion: 0, providers: new Set(), score: 0}; groups.push(group); }
    group.copies.push(item);
    group.score = Math.max(group.score, score(item));
    if (!group.providers.has(item.provider)) {
      const rank = (ranks.get(item.provider) ?? 0) + 1;
      ranks.set(item.provider, rank);
      group.fusion += 1 / (60 + rank);
      group.providers.add(item.provider);
    }
    if (compareEditions(item, group.album, [asked(item), asked(group.album)]) > 0) group.album = item;
  }
  groups.sort((a, b) => b.score - a.score || b.fusion - a.fusion);
  const related = groups.filter(group => group.score >= RELATED);
  return (related.length || tracks.length ? related : groups).map(group => withAlbumVersions(group.album, group.copies));
}

export type SearchCategory = "tracks" | "artists" | "albums";
type Evidence = TrackCredit & { album: string; provider?: string };

const songKey = derived((track: Evidence) => `${fold(searchTrackTitle(track.name))}|${fold(track.artist)}`);
const albumKey = derived((album: CatalogAlbum) => `${fold(albumBaseTitle(album.title))}|${fold(album.artist)}`);
const trackCredits = derived((track: Evidence) => artistCredits([track.artist]));
const trackAlbum = derived((track: Evidence) => fold(albumBaseTitle(track.album)));

/** How much a service's n-th answer (from 0) says about what the query means. */
const nativeWeight = (rank: number) => 1 / (1 + rank / 2);

/**
 * Which section the query is after, best first, from every service's own answer in its own
 * order (`tracks`, `artists` and `albums` as found, not as ranked here).
 *
 * Each section is scored by its best entry: how much of the query that entry explains, times
 * how firmly the services back it: how near the top of each service's answer it is and, for an
 * artist or an album, how many of each service's leading songs are theirs. A song or an album has
 * to be named by its title; songs that are merely by the artist asked for, or on the album asked
 * for, count for that artist or album instead. A self-titled album counts for its artist, so
 * "weezer" is the band before the blue album, and "abbey road" is the album rather than a
 * lesser-known song of that name every service also has.
 */
export function categoryOrder(query: string, tracks: Evidence[], artists: CatalogArtist[], albums: CatalogAlbum[]): SearchCategory[] {
  const services = [...new Set([...tracks, ...artists, ...albums].map(item => item.provider ?? "single"))];
  // Each key's best (lowest) place in each service's answer.
  const ranks = <T,>(items: T[], key: (item: T) => string, provider: (item: T) => string) => {
    const places = new Map<string, Map<string, number>>();
    const next = new Map<string, number>();
    for (const item of items) {
      const service = provider(item), id = key(item);
      const byService = places.get(id) ?? new Map<string, number>();
      if (byService.has(service)) continue;
      const rank = next.get(service) ?? 0;
      next.set(service, rank + 1);
      byService.set(service, rank);
      places.set(id, byService);
    }
    return (id: string) => [...places.get(id) ?? []].reduce((sum, [, rank]) => sum + nativeWeight(rank), 0) / services.length;
  };
  const songBacking = ranks(tracks, songKey, track => track.provider ?? "single");
  const artistBacking = ranks(artists, artist => fold(artist.name), artist => artist.provider);
  const albumBacking = ranks(albums, albumKey, album => album.provider);
  // Each service's first ten songs.
  const leading = services.map(service => tracks.filter(track => (track.provider ?? "single") === service).slice(0, 10)
    .map(track => ({ credits: trackCredits(track), album: trackAlbum(track) }))).filter(list => list.length);
  const share = (owns: (track: { credits: Set<string>; album: string }) => boolean) => leading.length ? leading.reduce((sum, list) => sum + list.filter(owns).length / list.length, 0) / leading.length : 0;
  const best = (values: number[]) => Math.max(0, ...values);

  const artistFit = (name: string) => {
    const { named, coverage } = matchName(name, query);
    return Math.min(named, coverage);
  };
  const seenArtists = new Set<string>();
  const artistScore = best(artists.map(artist => {
    const name = fold(artist.name);
    if (seenArtists.has(name)) return 0;
    seenArtists.add(name);
    const fit = remembered("artistFit", artist, query, () => artistFit(artist.name));
    if (fit < 0.5) return 0;
    const owned = share(track => track.credits.has(name));
    return fit * (0.3 + 0.35 * artistBacking(name) + 0.35 * Math.min(1, 2 * owned));
  }));
  const seenSongs = new Set<string>();
  const trackScore = best(tracks.map(track => {
    const key = songKey(track);
    if (seenSongs.has(key)) return 0;
    seenSongs.add(key);
    const fit = remembered("songFit", track, query, () => {
      const match = matchEntry({ title: searchTrackTitle(track.name), artists: [track.artist] }, query);
      return match.score * match.title;
    });
    return fit && fit * (0.3 + 0.7 * songBacking(key));
  }));
  const seenAlbums = new Set<string>();
  const albumScore = best(albums.map(album => {
    const key = albumKey(album);
    if (seenAlbums.has(key)) return 0;
    seenAlbums.add(key);
    const title = fold(albumBaseTitle(album.title));
    const credits = artistCredits(album.artists?.length ? album.artists.map(artist => artist.name) : [album.artist]);
    const fit = remembered("albumFit", album, query, () => {
      // Its artist's evidence, when the query is that artist's name.
      if (title === fold(album.artist) && artistFit(album.artist) >= 0.8) return 0;
      const match = matchEntry({ title: album.title, notes: album.version ? [album.version] : [], artists: [...credits] }, query);
      return match.score * match.title;
    });
    if (!fit) return 0;
    const owned = share(track => track.album === title && [...track.credits].some(name => credits.has(name)));
    return fit * (0.3 + 0.35 * albumBacking(key) + 0.35 * Math.min(1, 2 * owned));
  }));
  const scores: Record<SearchCategory, number> = { tracks: trackScore, artists: artistScore, albums: albumScore };
  return (["tracks", "artists", "albums"] as SearchCategory[]).sort((a, b) => scores[b] - scores[a]);
}
