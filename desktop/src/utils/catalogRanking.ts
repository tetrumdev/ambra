import type { CatalogArtist, CatalogAlbum } from "../api/server";

export function searchText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function compact(value: string) { return searchText(value).replace(/ /g, ""); }
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
export function textRelevance(value: string, query: string): number {
  const a = searchText(value), b = searchText(query);
  if (!a || !b) return 0;
  if (a === b || compact(a) === compact(b)) return 5;
  const words = a.split(" "), terms = b.split(" ");
  if (terms.every(term => words.includes(term))) return 4;
  if (a.includes(b)) return 3;
  if (terms.every(term => words.some(word => term.length >= 4 && distance(word, term) <= (term.length >= 8 ? 2 : 1)))) return 2;
  return 0;
}
// Retrieval variants are deliberately bounded; fuzzy ranking never changes entity identity.
export function fallbackQuery(query: string, artists: CatalogArtist[], hasResults: boolean): string | null {
  if (/\band\b/i.test(query)) return query.replace(/\band\b/gi, "&");
  if (/^[a-z]{4,8}$/i.test(query.trim()) && !artists.some(artist => textRelevance(artist.name, query) === 5)) return [...query.trim()].join(" ");
  const normalized = searchText(query);
  return !hasResults && normalized !== query.toLowerCase().trim() ? normalized : null;
}
type TrackCredit = { name: string; artist: string; album?: string };
export function searchTrackTitle(name: string) {
  // Edition labels do not change song identity; performance labels do.
  return name.replace(/\s*[([][^)\]]*\bremaster(?:ed)?\b[^)\]]*[)\]]/gi, "")
    .replace(/\s+[-–—]\s+(?:(?:19|20)\d{2}\s+)?remaster(?:ed)?(?:\s+(?:19|20)\d{2})?$/i, "").trim();
}
export function leadingSong(query: string, tracks: TrackCredit[]) {
  const first = tracks[0];
  return first && (textRelevance(searchTrackTitle(first.name), query) === 5 || entityRelevance(searchTrackTitle(first.name), first.artist, query) === 6) ? first : null;
}

export function matchingTrackArtist(query: string, tracks: TrackCredit[]): string | null {
  const names = new Set(tracks.filter(track => {
    const title = searchTrackTitle(track.name);
    return textRelevance(`${title} ${track.artist}`, query) === 5 || textRelevance(`${track.artist} ${title}`, query) === 5;
  }).map(track => track.artist));
  // Only infer a credit when the song-and-artist match is unambiguous.
  return names.size === 1 ? [...names][0] : null;
}
export function rankArtists(values: CatalogArtist[], query: string, tracks: TrackCredit[] = []) {
  const credit = matchingTrackArtist(query, tracks) ?? leadingSong(query, tracks)?.artist;
  const score = (artist: CatalogArtist) => credit && searchText(artist.name) === searchText(credit) ? 6 : textRelevance(artist.name, query);
  // Equal names within one service can be different artists. Only collapse across services,
  // keeping each service's entry so the artist page can gather releases from all of them.
  const result: CatalogArtist[] = [];
  for (const item of values) {
    if (result.some(other => other.sources?.some(source => source.id === item.id) ?? other.id === item.id)) continue;
    const index = result.findIndex(other => searchText(other.name) === searchText(item.name) && other.provider !== item.provider);
    if (index < 0) { result.push(item); continue; }
    const sources = result[index].sources ?? [result[index]];
    if (!sources.some(source => source.provider === item.provider)) result[index] = { ...result[index], sources: [...sources, item] };
  }
  return result.sort((a, b) => score(b) - score(a));
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
export function albumIdentity(album: CatalogAlbum) {
  const version = album.version && !editionLabel(album.version) ? album.version : "";
  // Some services repeat the version in the title ("… (Instrumental)"); others keep it separate.
  const title = searchText(albumBaseTitle(album.title));
  const bare = version && title.endsWith(` ${searchText(version)}`) ? title.slice(0, -searchText(version).length - 1) : title;
  return `${bare}|${searchText(version)}`;
}

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
  const theirs = albumArtistNames(right);
  return [...albumArtistNames(left)].some(name => theirs.has(name));
}

// A choice is filed under each credited artist, so a service listing collaborators differently still finds it.
const preferenceKeys = (album: CatalogAlbum) => [...albumArtistNames(album)].map(name => `${name}|${albumIdentity(album)}`);
const losslessProviders = new Set(["qobuz", "tidal", "local"]);
/** Higher is better: explicit, then bit depth and sample rate, with lossless services assumed CD quality. */
function editionQuality(album: CatalogAlbum): number[] {
  const lossless = losslessProviders.has(album.provider);
  return [Number(album.explicit ?? false), album.maximumBitDepth ?? (lossless ? 16 : 0), album.maximumSamplingRateKHz ?? (lossless ? 44.1 : 0)];
}

const compareEditions = (a: number[], b: number[]) => a.map((value, index) => value - b[index]).find(difference => difference !== 0) ?? 0;

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
    const representative = !current || compareEditions(editionQuality(album), editionQuality(current)) > 0 ? album : current;
    const merged = withAlbumVersions(representative, current ? [current, album] : [album]);
    if (index < 0) best.push(merged);
    else best[index] = merged;
  }
  return best;
}

export function rankAlbums(values: CatalogAlbum[], query: string, tracks: TrackCredit[] = []) {
  const song = leadingSong(query, tracks);
  const score = (album: CatalogAlbum) => {
    const raw = entityRelevance(album.title, album.artist, query);
    const direct = raw === 4 ? 5 : raw;
    if (textRelevance(album.artist, query) === 5 && tracks[0] && textRelevance(tracks[0].artist, query) === 5) return 7;
    if (song && searchText(album.artist) === searchText(song.artist)) {
      if (song.album && searchText(album.title) === searchText(song.album)) return 8;
      if (textRelevance(album.title, query) === 5) return 7;
    }
    return direct;
  };
  // An edition the query names (deluxe, 2011 remaster…) wins over a better-sounding one.
  const terms = searchText(query).split(" ").filter(term => editionWords.has(term) || /^\d{4}$/.test(term));
  const asked = (album: CatalogAlbum) => terms.filter(term => searchText(`${album.title} ${album.version ?? ""}`).split(" ").includes(term)).length;
  // Every edition and service of one album collapses into its best copy; earlier results win ties.
  const groups: { album: CatalogAlbum; copies: CatalogAlbum[]; fusion: number; providers: Set<string> }[] = [];
  const ranks = new Map<string, number>();
  const seen = new Set<string>();
  for (const item of values) {
    const key = `${item.provider}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let group = groups.find(group => group.copies.some(copy => sameAlbum(copy, item)));
    if (!group) { group = {album: item, copies: [], fusion: 0, providers: new Set()}; groups.push(group); }
    group.copies.push(item);
    if (!group.providers.has(item.provider)) {
      const rank = (ranks.get(item.provider) ?? 0) + 1;
      ranks.set(item.provider, rank);
      group.fusion += 1 / (60 + rank);
      group.providers.add(item.provider);
    }
    const a = [asked(item), ...editionQuality(item)], b = [asked(group.album), ...editionQuality(group.album)];
    if (compareEditions(a, b) > 0) group.album = item;
  }
  return groups.sort((a, b) => score(b.album) - score(a.album) || b.fusion - a.fusion).map(group => withAlbumVersions(group.album, group.copies));
}

// Match a title and its actual credited artist together. Artist names embedded in
// tribute/karaoke titles are only title text, not evidence of that artist credit.
function entityRelevance(title: string, artist: string, query: string) {
  const titleMatch = textRelevance(title, query);
  const combined = Math.max(textRelevance(`${title} ${artist}`, query), textRelevance(`${artist} ${title}`, query));
  return Math.max(titleMatch, combined === 5 ? 6 : combined);
}

export type SearchCategory = "tracks" | "artists" | "albums";
export function categoryOrder(query: string, tracks: { name: string; artist: string; album: string }[], artists: CatalogArtist[], albums: CatalogAlbum[], evidence: (TrackCredit & { album: string; provider?: string })[] = tracks): SearchCategory[] {
  const best = (values: number[]) => Math.max(0, ...values);
  const artistMatch = best(artists.map(a => textRelevance(a.name, query)));
  const albumMatch = best(albums.map(a => entityRelevance(a.title, a.artist, query)));
  const trackMatch = best(tracks.map(t => entityRelevance(searchTrackTitle(t.name), t.artist, query)));
  const support = {tracks: 0, artists: 0, albums: 0};
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const track of evidence) {
    const provider = track.provider ?? "single";
    const key = `${provider}:${searchText(searchTrackTitle(track.name))}:${searchText(track.artist)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const index = counts.get(provider) ?? 0;
    counts.set(provider, index + 1);
    if (index >= 3) continue;
    const weight = [6, 3, 1][index];
    if (textRelevance(searchTrackTitle(track.name), query) === 5) support.tracks += weight;
    if (textRelevance(track.artist, query) === 5) support.artists += weight;
    if (textRelevance(track.album, query) >= 4) support.albums += weight;
  }
  // Native leading recordings inform intent before title-only ranking can bury
  // album matches. Low-ranked namesakes and duplicate editions add no support.
  const scores: Record<SearchCategory, number> = {
    tracks: trackMatch * 10 + Math.min(20, support.tracks),
    artists: artistMatch * 10 + Math.min(20, support.artists),
    albums: albumMatch * 10 + Math.min(20, support.albums),
  };
  // A leading exact song match must not lose to namesake artists merely
  // because they contribute more unrelated songs further down the results.
  if (leadingSong(query, tracks) && support.tracks > 0 && support.tracks >= support.albums && trackMatch >= artistMatch && trackMatch >= albumMatch) {
    scores.tracks = Math.max(scores.tracks, scores.artists, scores.albums);
  }
  return (["tracks", "artists", "albums"] as SearchCategory[]).sort((a, b) => scores[b] - scores[a]);
}
