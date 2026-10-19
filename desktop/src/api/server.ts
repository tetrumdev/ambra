import { fallbackQuery, textRelevance, matchingTrackArtist, leadingSong, searchText } from "../utils/catalogRanking";
import type {
  GlobalTrackId,
  MusicProvider,
  PlaybackKind,
  Track,
  TrackArtist,
} from "../types/music";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { fetchWhenServerReady } from "../utils/serverReadiness";
import { SearchCache } from "../utils/searchCache";
import { parseTrackLyrics, type TrackLyrics } from "../types/lyrics";

export const serverBaseUrl = (
  import.meta.env.VITE_AMBRA_SERVER_URL ?? "http://127.0.0.1:38147"
).replace(/\/$/, "");

type RemoteAlbum = {
  providerId: string;
  title: string;
  version: string | null;
  artists: TrackArtist[];
  coverUrl: string | null;
  releaseDate: string | null;
  label: string | null;
  genres: string[];
  upc: string | null;
};

export type RemoteTrack = {
  id: string;
  provider: MusicProvider;
  providerTrackId: string;
  title: string;
  version: string | null;
  primaryArtist: TrackArtist;
  artists: TrackArtist[];
  album: RemoteAlbum | null;
  durationSeconds: number;
  trackNumber: number | null;
  discNumber: number | null;
  explicit: boolean;
  isrc: string | null;
  copyright: string | null;
  quality: string | null;
  maximumSamplingRateKHz: number | null;
  maximumBitDepth: number | null;
  playback: {
    kind: PlaybackKind;
    url: string;
  };
};

type LibraryResponse = {
  tracks: RemoteTrack[];
  /** Saved tracks the server could not load this time; keep cached copies. */
  unavailableTrackIds?: GlobalTrackId[];
};

export type ServerLibrary = {
  tracks: Track[];
  unavailableTrackIds: Set<GlobalTrackId>;
};

export type SearchProvider =
  | Extract<MusicProvider, "tidal" | "qobuz" | "spotify">
  | "all";

export type StreamingProvider = Exclude<SearchProvider, "all">;

export type ServiceAuthStatus = Record<StreamingProvider, boolean>;

export type ServiceAuthStart = {
  status: "connected" | "callbackRequired";
  loginUrl: string | null;
};

async function responseError(response: Response) {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Preserve non-JSON server errors.
  }
  return body || `HTTP ${response.status}`;
}

export type { LyricSegment as LyricWord, LyricLine, TrackLyrics } from "../types/lyrics";

export async function trackLyrics(track: Track, signal: AbortSignal): Promise<TrackLyrics> {
  const query = new URLSearchParams({
    trackName: track.name,
    artistName: track.artist,
    albumName: track.album,
    durationSeconds: String(track.durationSeconds),
  });
  if (track.isrc) query.set("isrc", track.isrc);
  if (track.version) query.set("version", track.version);
  if (track.provider === "spotify") query.set("spotifyId", track.providerTrackId);
  for (let attempt = 0; ; attempt++) {
    // Give temporary connection/upstream failures one automatic retry before
    // asking the listener to retry. Each attempt gets its own timeout.
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1000));
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`${serverBaseUrl}/api/lyrics?${query}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        cache: "no-store",
      });
    } catch (error) {
      const temporary = error instanceof TypeError
        || (error instanceof DOMException && error.name === "TimeoutError");
      if (signal.aborted || attempt > 0 || !temporary) throw error;
      continue;
    }
    if (!response.ok) {
      const message = await responseError(response);
      if (attempt === 0 && [502, 503, 504].includes(response.status)) continue;
      throw new Error(message);
    }
    return parseTrackLyrics(await response.json());
  }
}

export async function serviceAuthStatus(): Promise<ServiceAuthStatus> {
  const response = await fetch(`${serverBaseUrl}/api/auth/status`);
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<ServiceAuthStatus>;
}

export async function startServiceAuth(
  provider: StreamingProvider,
): Promise<ServiceAuthStart> {
  const response = await fetch(`${serverBaseUrl}/api/auth/${provider}/start`, {
    method: "POST",
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<ServiceAuthStart>;
}

export async function completeServiceAuth(
  provider: Exclude<StreamingProvider, "spotify">,
  callbackUrl: string,
): Promise<void> {
  const response = await fetch(`${serverBaseUrl}/api/auth/${provider}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callbackUrl }),
  });
  if (!response.ok) throw new Error(await responseError(response));
}

export type CatalogArtist = {
  id: string; provider: MusicProvider; name: string; imageUrl: string | null;
  /** The same artist on every service it was found on, this entry included. */
  sources?: CatalogArtist[];
};
export type CatalogAlbum = { id: string; provider: MusicProvider; title: string; artist: string; artists?: TrackArtist[]; imageUrl: string | null; upc?: string | null; releaseDate?: string | null; releaseType?: string | null; version?: string | null; explicit?: boolean | null; maximumBitDepth?: number | null; maximumSamplingRateKHz?: number | null };
export type SearchPage = {
  artists?: CatalogArtist[];
  albums?: CatalogAlbum[];
  tracks: Track[];
  nextOffset: number | null;
};

export async function configuredSearchProviders(signal?: AbortSignal): Promise<StreamingProvider[]> {
  const response = await fetch(`${serverBaseUrl}/api/search/providers`, { signal });
  if (!response.ok) throw new Error("Could not load available music services");
  const body = await response.json() as { providers: StreamingProvider[] };
  return body.providers;
}

export type ArtworkQuality = {
  provider: Exclude<MusicProvider, "local">;
  url: string;
  width: number;
  height: number;
  colors: string[];
};

type TrackPlayback = {
  quality: string;
  bitrateKbps?: number | null;
  maximumSamplingRateKHz: number | null;
  maximumBitDepth: number | null;
  playback: {
    kind: PlaybackKind;
    url: string;
  };
};

const artworkQualityRequests = new Map<string, Promise<ArtworkQuality | null>>();
const artworkPaletteVersion = "thumbnail-v1";

function artworkQuery(track: Track) {
  const url = track.nativeCover;
  if (track.provider === "local" || !url?.startsWith("https://")) return null;
  return new URLSearchParams({ provider: track.provider, url }).toString();
}

export function thumbnailArtwork(track: Track) {
  const query = artworkQuery(track);
  return query ? `${serverBaseUrl}/api/artwork/thumbnail?${query}` : track.cover;
}

// Cards and portraits must use the same persistent thumbnail cache as tracks.
export function thumbnailSource(source: string): string {
  let url: URL;
  try { url = new URL(source); } catch { return source; }
  if (url.protocol !== "https:") return source;
  const provider = url.hostname === "resources.tidal.com" ? "tidal"
    : url.hostname === "static.qobuz.com" ? "qobuz"
    : url.hostname === "i.scdn.co" ? "spotify" : null;
  return provider ? `${serverBaseUrl}/api/artwork/thumbnail?${new URLSearchParams({ provider, url: source })}` : source;
}

export type ArtworkPalette = { colors: string[]; weights: number[] };

const paletteRequests = new Map<string, Promise<ArtworkPalette>>();
export function artworkPalette(track: Track): Promise<ArtworkPalette> {
  const query = artworkQuery(track);
  if (!query) return Promise.resolve({ colors: [], weights: [] });
  const cached = paletteRequests.get(query);
  if (cached) {
    paletteRequests.delete(query);
    paletteRequests.set(query, cached);
    return cached;
  }
  const request = fetch(`${serverBaseUrl}/api/artwork/palette?${query}&weighted=true`)
    .then(async response => {
      if (!response.ok) throw new Error(`Artwork palette HTTP ${response.status}`);
      const palette = await response.json() as ArtworkPalette | string[];
      // Older servers don't include coverage; fall back to the original blend.
      return Array.isArray(palette)
        ? { colors: palette, weights: palette.map(() => 1 / palette.length) }
        : palette;
    }).catch(() => {
      if (paletteRequests.get(query) === request) paletteRequests.delete(query);
      return { colors: [], weights: [] };
    });
  paletteRequests.set(query, request);
  if (paletteRequests.size > 512) paletteRequests.delete(paletteRequests.keys().next().value!);
  return request;
}

export function highestQualityArtwork(
  track: Track,
): Promise<ArtworkQuality | null> {
  return highestQualityAlbumArtwork({
    provider: track.provider,
    albumId: track.albumId,
    upc: track.upc,
    coverUrl: track.nativeCover,
  });
}

/** Resolves an album's best available cover from its provider's own cover URL. */
export function highestQualityAlbumArtwork(album: {
  provider: MusicProvider;
  albumId: string | null;
  upc?: string | null;
  coverUrl: string | null;
}): Promise<ArtworkQuality | null> {
  if (
    album.provider === "local" ||
    album.albumId === null ||
    album.coverUrl === null ||
    !album.coverUrl.startsWith("https://")
  ) {
    return Promise.resolve(null);
  }

  const cacheKey = [
    artworkPaletteVersion,
    album.provider,
    album.albumId,
    album.upc ?? "",
    album.coverUrl,
  ].join(":");
  const cached = artworkQualityRequests.get(cacheKey);
  if (cached) {
    artworkQualityRequests.delete(cacheKey);
    artworkQualityRequests.set(cacheKey, cached);
    return cached;
  }

  const request = fetch(`${serverBaseUrl}/api/quality/artwork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceProvider: album.provider,
      albumId: album.albumId,
      upc: album.upc ?? null,
      coverUrl: album.coverUrl,
    }),
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(
          `Artwork quality resolver returned HTTP ${response.status}`,
        );
      }
      const artwork = (await response.json()) as ArtworkQuality;
      return artwork;
    })
    .catch((reason: unknown) => {
      if (artworkQualityRequests.get(cacheKey) === request) artworkQualityRequests.delete(cacheKey);
      console.warn("Could not resolve highest-quality album artwork:", reason);
      return null;
    });

  artworkQualityRequests.set(cacheKey, request);
  if (artworkQualityRequests.size > 256) {
    artworkQualityRequests.delete(artworkQualityRequests.keys().next().value!);
  }
  return request;
}

export function playableTrack(track: RemoteTrack): Track {
  const displayTitle = withVersion(track.title, track.version);
  const displayAlbum = withVersion(
    track.album?.title ?? "Unknown Album",
    track.album?.version ?? null,
  );
  return {
    globalId: track.id,
    provider: track.provider,
    providerTrackId: track.providerTrackId,
    playbackKind: track.playback.kind,
    audio: `${serverBaseUrl}${track.playback.url}`,
    cover: track.album?.coverUrl ?? whiteArtwork,
    nativeCover: track.album?.coverUrl ?? null,
    name: displayTitle,
    version: track.version,
    album: displayAlbum,
    albumVersion: track.album?.version ?? null,
    albumId: track.album?.providerId ?? null,
    albumArtists: track.album?.artists ?? [],
    artist: track.primaryArtist.name,
    artists: track.artists,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
    durationSeconds: track.durationSeconds,
    releaseDate: track.album?.releaseDate ?? null,
    explicit: track.explicit,
    isrc: track.isrc,
    copyright: track.copyright,
    label: track.album?.label ?? null,
    genres: track.album?.genres ?? [],
    upc: track.album?.upc ?? null,
    quality: track.quality,
    maximumSamplingRateKHz: track.maximumSamplingRateKHz,
    maximumBitDepth: track.maximumBitDepth,
  };
}

function withVersion(title: string, version: string | null) {
  return version?.trim() ? `${title} (${version})` : title;
}

async function responseTracks(response: Response): Promise<Track[]> {
  return (await libraryResponse(response)).tracks.map(playableTrack);
}

async function libraryResponse(response: Response): Promise<LibraryResponse> {
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") message = parsed.error;
    } catch {
      // Preserve non-JSON upstream errors verbatim.
    }
    throw new Error(`Ambra server returned HTTP ${response.status}: ${message}`);
  }

  return (await response.json()) as LibraryResponse;
}

export async function loadServerLibrary(signal?: AbortSignal): Promise<ServerLibrary> {
  const library = await libraryResponse(
    await fetchWhenServerReady(`${serverBaseUrl}/api/library`, signal),
  );
  return {
    tracks: library.tracks.map(playableTrack),
    unavailableTrackIds: new Set(library.unavailableTrackIds ?? []),
  };
}

export async function removeServerTracks(
  tracks: Pick<Track, "provider" | "providerTrackId">[],
): Promise<void> {
  const response = await fetch(`${serverBaseUrl}/api/library/tracks/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tracks: tracks.map(({ provider, providerTrackId }) => ({ provider, providerTrackId })),
    }),
  });
  if (!response.ok) throw new Error(await responseError(response));
}

export async function addServerAlbum(url: string): Promise<Track[]> {
  return responseTracks(
    await fetch(`${serverBaseUrl}/api/library/albums`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  );
}

export async function addServerTrack(
  provider: SearchProvider,
  providerTrackId: string,
): Promise<Track[]> {
  return responseTracks(
    await fetch(`${serverBaseUrl}/api/library/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, providerTrackId }),
    }),
  );
}

export async function searchServerTracks(
  query: string,
  provider: StreamingProvider,
  signal?: AbortSignal,
  offset = 0,
  limit = 20,
): Promise<SearchPage> {
  const parameters = new URLSearchParams({ query, provider, offset: String(offset), limit: String(limit) });
  const response = await fetch(`${serverBaseUrl}/api/search/tracks?${parameters}`, { signal });
  if (!response.ok) {
    await responseTracks(response); // Use the same structured server error handling.
    throw new Error("Search failed");
  }
  const page = await response.json() as LibraryResponse & { nextOffset: number | null };
  if (page.nextOffset !== null && (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset)) {
    throw new Error("Search returned an invalid pagination cursor. Restart the Ambra server.");
  }
  return { tracks: page.tracks.map(playableTrack), nextOffset: page.nextOffset };
}

export async function refreshTrackMetadata(
  track: Track,
  signal?: AbortSignal,
): Promise<Track> {
  if (track.provider === "local") return track;

  const response = await fetch(
    `${serverBaseUrl}/api/providers/${track.provider}/tracks/${encodeURIComponent(track.providerTrackId)}/metadata`,
    { signal },
  );
  if (!response.ok) throw new Error(await responseError(response));
  return playableTrack((await response.json()) as RemoteTrack);
}

export async function resolveTrackPlayback(
  track: Track,
  signal?: AbortSignal,
): Promise<Track> {  if (track.provider !== "tidal") return track;

  const parameters = new URLSearchParams({
    durationSeconds: String(track.durationSeconds),
  });
  const response = await fetch(
    `${serverBaseUrl}/api/providers/tidal/tracks/${encodeURIComponent(track.providerTrackId)}/playback?${parameters}`,
    { signal },
  );
  if (!response.ok) {
    throw new Error(
      `Tidal playback resolver returned HTTP ${response.status}`,
    );
  }
  const details = (await response.json()) as TrackPlayback;
  return {
    ...track,
    audio: `${serverBaseUrl}${details.playback.url}`,
    playbackKind: details.playback.kind,
    quality: details.quality,
    bitrateKbps: details.bitrateKbps ?? null,
    maximumSamplingRateKHz: details.maximumSamplingRateKHz,
    maximumBitDepth: details.maximumBitDepth,
  };
}

const catalogResponses = new SearchCache<SearchPage>();

export async function searchServerCatalog(query: string, provider: StreamingProvider, signal?: AbortSignal): Promise<SearchPage> {
  const fetchCatalog = async (value: string, requestSignal = signal): Promise<SearchPage> => {
    requestSignal?.throwIfAborted();
    const parameters = new URLSearchParams({ query: value, provider, limit: "20" });
    const key = parameters.toString();
    const cached = catalogResponses.get(key);
    if (cached) return cached;
    const response = await fetch(`${serverBaseUrl}/api/search/catalog?${parameters}`, { signal: requestSignal });
    if (!response.ok) { await responseTracks(response); throw new Error("Catalog search failed"); }
    const page = await response.json() as { tracks: RemoteTrack[]; artists: CatalogArtist[]; albums: CatalogAlbum[] };
    requestSignal?.throwIfAborted();
    const result: SearchPage = { ...page, tracks: page.tracks.map(playableTrack), nextOffset: null };
    catalogResponses.set(key, result);
    return result;
  };
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
      page.albums.push({id: track.albumId.startsWith(`${provider}:`) ? track.albumId : `${provider}:${track.albumId}`, provider, title: track.album, artist: track.albumArtists.map(artist => artist.name).join(", ") || track.artist, imageUrl: track.cover, upc: track.upc, releaseDate: track.releaseDate, version: track.albumVersion});
    }
  }
  const missingArtist = credit && !page.artists?.some(artist => textRelevance(artist.name, credit) === 5) ? credit : null;
  const variant = missingArtist ?? (/\band\b/i.test(query) && page.albums?.some(album => textRelevance(album.title, query) === 5) ? null : fallbackQuery(query, page.artists ?? [], Boolean(page.tracks.length || page.artists?.length || page.albums?.length)));
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

export type ArtistProfile = { artist: CatalogArtist; biography: string | null; biographySource: string | null; popularTracks: Track[]; popularTracksError: string | null };
type ArtistAlbumsPage = { albums: CatalogAlbum[]; nextOffset: number | null };
const artistProfiles = new SearchCache<ArtistProfile>(600_000, 80);
const artistAlbumPages = new SearchCache<ArtistAlbumsPage>(600_000, 80);
const artistRequests = new Map<string, Promise<unknown>>();
const artistKey = (artist: CatalogArtist) => `${artist.provider}:${providerEntityId(artist.id, artist.provider)}`;

export const cachedArtistProfile = (artist: CatalogArtist) => artistProfiles.get(artistKey(artist));
export const cachedArtistAlbums = (artist: CatalogArtist) => artistAlbumPages.get(`${artistKey(artist)}:0`);

async function sharedArtistRequest<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let request = artistRequests.get(key) as Promise<T> | undefined;
  if (!request) {
    request = work().finally(() => artistRequests.delete(key));
    artistRequests.set(key, request);
  }
  // Navigation may unmount the prefetch owner. Keep shared work alive for the page.
  const value = await request;
  signal?.throwIfAborted();
  return value;
}

export async function loadArtistDetails(artist: CatalogArtist): Promise<CatalogArtist> {
  return sharedArtistRequest(`details:${artistKey(artist)}`, async () => {
    const response = await fetch(`${serverBaseUrl}/api/providers/${artist.provider}/artists/${providerEntityId(artist.id, artist.provider)}/metadata`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(await responseError(response));
    return response.json() as Promise<CatalogArtist>;
  });
}

function providerEntityId(id: string, provider: MusicProvider) {
  return encodeURIComponent(id.startsWith(`${provider}:`) ? id.slice(provider.length + 1) : id);
}

const albumTracks = new SearchCache<Track[]>(600_000, 80);

export async function loadAlbumTracks(album: CatalogAlbum, signal?: AbortSignal): Promise<Track[]> {
  if (album.provider === "local") return [];
  const key = `${album.provider}:${providerEntityId(album.id, album.provider)}`;
  signal?.throwIfAborted();
  const cached = albumTracks.get(key);
  if (cached) return cached;
  // Shared and not tied to the caller's signal, so a hover prefetch or a quick
  // back-and-forward reuses one in-flight request instead of starting over.
  return sharedArtistRequest(`album:${key}`, async () => {
    const tracks = await responseTracks(await fetch(`${serverBaseUrl}/api/providers/${album.provider}/albums/${key.slice(album.provider.length + 1)}/tracks`, { signal: AbortSignal.timeout(60_000) }));
    albumTracks.set(key, tracks);
    return tracks;
  }, signal);
}

export async function loadArtistAlbums(artist: CatalogArtist, offset = 0, signal?: AbortSignal, refresh = false): Promise<ArtistAlbumsPage> {
  if (artist.provider === "local") return { albums: [], nextOffset: null };
  const key = `${artistKey(artist)}:${offset}`;
  signal?.throwIfAborted();
  const cached = !refresh && artistAlbumPages.get(key);
  if (cached) return cached;
  return sharedArtistRequest(`albums:${key}`, async () => {
    const response = await fetch(`${serverBaseUrl}/api/providers/${artist.provider}/artists/${providerEntityId(artist.id, artist.provider)}/albums?offset=${offset}&limit=30`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(await responseError(response));
    const page = await response.json() as { albums: CatalogAlbum[]; nextOffset: number | null };
    if (page.nextOffset !== null && (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset)) throw new Error("Invalid artist album pagination cursor");
    artistAlbumPages.set(key, page);
    return page;
  }, signal);
}

export async function loadArtistProfile(artist: CatalogArtist, signal?: AbortSignal, refresh = false): Promise<ArtistProfile> {
  const key = artistKey(artist);
  signal?.throwIfAborted();
  const cached = !refresh && artistProfiles.get(key);
  if (cached) return cached;
  return sharedArtistRequest(`profile:${key}`, async () => {
    const response = await fetch(`${serverBaseUrl}/api/providers/${artist.provider}/artists/${providerEntityId(artist.id, artist.provider)}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(await responseError(response));
    const profile = await response.json() as Omit<ArtistProfile, "popularTracks"> & { popularTracks: RemoteTrack[] };
    const value = { ...profile, popularTracks: profile.popularTracks.map(playableTrack) };
    if (!value.popularTracksError) artistProfiles.set(key, value);
    return value;
  }, signal);
}
