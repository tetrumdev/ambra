import { fallbackQuery, textRelevance, matchingTrackArtist, leadingSong, searchText } from "../utils/catalogRanking";
import type {
  MusicProvider,
  PlaybackKind,
  Track,
  TrackArtist,
} from "../types/music";
import fallbackCover from "../assets/images/fallbackCover.png";
import { SearchCache } from "../utils/searchCache";

const serverBaseUrl = (
  import.meta.env.VITE_AMBRA_SERVER_URL ?? "http://127.0.0.1:8787"
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

export type CatalogArtist = { id: string; provider: StreamingProvider; name: string; imageUrl: string | null };
export type CatalogAlbum = { id: string; provider: StreamingProvider; title: string; artist: string; imageUrl: string | null; upc?: string | null; releaseDate?: string | null; version?: string | null; explicit?: boolean | null; maximumBitDepth?: number | null; maximumSamplingRateKHz?: number | null };
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
  maximumSamplingRateKHz: number | null;
  maximumBitDepth: number | null;
  playback: {
    kind: PlaybackKind;
    url: string;
  };
};

const artworkQualityRequests = new Map<string, Promise<ArtworkQuality | null>>();
const artworkPaletteVersion = "palette-v4";

export function highestQualityArtwork(
  track: Track,
): Promise<ArtworkQuality | null> {
  if (
    track.provider === "local" ||
    track.albumId === null ||
    track.nativeCover === null ||
    !track.nativeCover.startsWith("https://")
  ) {
    return Promise.resolve(null);
  }

  const cacheKey = [
    artworkPaletteVersion,
    track.provider,
    track.albumId,
    track.upc ?? "",
    track.nativeCover,
  ].join(":");
  const cached = artworkQualityRequests.get(cacheKey);
  if (cached) return cached;

  const request = fetch(`${serverBaseUrl}/api/quality/artwork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceProvider: track.provider,
      albumId: track.albumId,
      upc: track.upc,
      coverUrl: track.nativeCover,
    }),
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(
          `Artwork quality resolver returned HTTP ${response.status}`,
        );
      }
      const artwork = (await response.json()) as ArtworkQuality;
      if (!Array.isArray(artwork.colors) || artwork.colors.length !== 4) {
        artworkQualityRequests.delete(cacheKey);
      }
      return artwork;
    })
    .catch((reason: unknown) => {
      artworkQualityRequests.delete(cacheKey);
      console.warn("Could not resolve highest-quality album artwork:", reason);
      return null;
    });

  artworkQualityRequests.set(cacheKey, request);
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
    cover: track.album?.coverUrl ?? fallbackCover,
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

  const library = (await response.json()) as LibraryResponse;
  return library.tracks.map(playableTrack);
}

export async function loadServerTracks(): Promise<Track[]> {
  return responseTracks(await fetch(`${serverBaseUrl}/api/library`));
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

export async function resolveTrackPlayback(
  track: Track,
  signal?: AbortSignal,
): Promise<Track> {
  if (track.provider !== "tidal") return track;

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
