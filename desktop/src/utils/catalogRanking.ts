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
  // Equal names within one service can be different artists. Only collapse across services.
  const result: CatalogArtist[] = [];
  for (const item of values) if (!result.some(other => other.id === item.id || (other.provider !== item.provider && searchText(other.name) === searchText(item.name)))) result.push(item);
  return result.sort((a, b) => score(b) - score(a));
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
  const groups: { album: CatalogAlbum; fusion: number; providers: Set<string> }[] = [];
  const ranks = new Map<string, number>();
  const seen = new Set<string>();
  for (const item of values) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    let group = groups.find(group => searchText(group.album.artist) === searchText(item.artist) && searchText(group.album.title) === searchText(item.title) && searchText(group.album.version ?? "") === searchText(item.version ?? ""));
    if (!group) { group = {album: item, fusion: 0, providers: new Set()}; groups.push(group); }
    if (!group.providers.has(item.provider)) {
      const rank = (ranks.get(item.provider) ?? 0) + 1;
      ranks.set(item.provider, rank);
      group.fusion += 1 / (60 + rank);
      group.providers.add(item.provider);
    }
    const a = item, b = group.album;
    const quality = Number(a.explicit ?? false) - Number(b.explicit ?? false) || (a.maximumBitDepth ?? 0) - (b.maximumBitDepth ?? 0) || (a.maximumSamplingRateKHz ?? 0) - (b.maximumSamplingRateKHz ?? 0);
    if (quality > 0) group.album = item;
  }
  return groups.sort((a, b) => score(b.album) - score(a.album) || b.fusion - a.fusion).map(group => group.album);
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
  return (["tracks", "artists", "albums"] as SearchCategory[]).sort((a, b) => scores[b] - scores[a]);
}
