import { fallbackQuery, leadingSong, matchingTrackArtist, searchText, textRelevance } from "./catalogRanking";
import type { SearchPage, StreamingProvider } from "../api/server";

/**
 * One service's catalog answer, completed from its own songs: the artists and albums credited on
 * the songs the query names, and one retry under another spelling when the answer misses the
 * artist it found songs by, or found nothing. Shared by desktop and the phone, which differ only
 * in how they reach the server (`fetchCatalog`).
 */
export async function enrichCatalogPage(query: string, provider: StreamingProvider, signal: AbortSignal | undefined,
  fetchCatalog: (value: string, signal?: AbortSignal) => Promise<SearchPage>): Promise<SearchPage> {
  const page = await fetchCatalog(query);
  const credit = matchingTrackArtist(query, page.tracks) ?? leadingSong(query, page.tracks)?.artist;
  // Provider track metadata already includes real catalog identities and artwork.
  // Reuse those relationships instead of searching an unrelated namesake or
  // requiring another network round trip for an artist/album already identified.
  for (const track of page.tracks) {
    const related = (credit && searchText(track.artist) === searchText(credit)) || textRelevance(track.artist, query) === 5;
    if (!related) continue;
    for (const artist of track.artists) {
      if (!artist.providerId || searchText(artist.name) !== searchText(track.artist)) continue;
      page.artists ??= [];
      page.artists.push({id: artist.providerId.startsWith(`${provider}:`) ? artist.providerId : `${provider}:${artist.providerId}`, provider, name: artist.name, imageUrl: artist.imageUrl});
    }
    if (track.albumId) {
      page.albums ??= [];
      page.albums.push({id: track.albumId.startsWith(`${provider}:`) ? track.albumId : `${provider}:${track.albumId}`, provider, title: track.album, artist: track.albumArtists.map(artist => artist.name).join(", ") || track.artist, artists: track.albumArtists, imageUrl: track.cover, upc: track.upc, releaseDate: track.releaseDate, version: track.albumVersion, maximumBitDepth: track.maximumBitDepth, maximumSamplingRateKHz: track.maximumSamplingRateKHz});
    }
  }
  const missingArtist = credit && !page.artists?.some(artist => textRelevance(artist.name, credit) === 5) ? credit : null;
  const variant = missingArtist ?? (/\band\b/i.test(query) && page.albums?.some(album => textRelevance(album.title, query) === 5) ? null : fallbackQuery(query, Boolean(page.tracks.length || page.artists?.length || page.albums?.length)));
  if (!variant || signal?.aborted) return page;
  try {
    const extra = await fetchCatalog(variant, signal ? AbortSignal.any([signal, AbortSignal.timeout(1800)]) : AbortSignal.timeout(1800));
    if (missingArtist) return {
      ...page,
      artists: [...page.artists ?? [], ...(extra.artists ?? []).filter(artist => textRelevance(artist.name, missingArtist) === 5)],
      albums: [...page.albums ?? [], ...(extra.albums ?? []).filter(album => searchText(album.artist) === searchText(missingArtist) && page.tracks.slice(0, 1).some(track => searchText(track.album) === searchText(album.title)))],
    };
    return { tracks: [...page.tracks, ...extra.tracks], artists: [...page.artists ?? [], ...extra.artists ?? []], albums: [...page.albums ?? [], ...extra.albums ?? []], nextOffset: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return page; // A best-effort spelling retry must not discard successful primary results.
  }
}
