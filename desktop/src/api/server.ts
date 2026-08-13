import type {
  MusicProvider,
  PlaybackKind,
  Track,
  TrackArtist,
} from "../types/music";
import fallbackCover from "../assets/images/fallbackCover.png";

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

export type SearchProvider = Extract<
  MusicProvider,
  "tidal" | "qobuz" | "spotify"
>;

export type ArtworkQuality = {
  provider: Exclude<MusicProvider, "local">;
  url: string;
  width: number;
  height: number;
  colors: string[];
};

const artworkQualityRequests = new Map<string, Promise<ArtworkQuality | null>>();
const artworkPaletteVersion = "palette-v2";

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
      if (!Array.isArray(artwork.colors) || artwork.colors.length !== 3) {
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
  provider: SearchProvider,
  signal?: AbortSignal,
): Promise<Track[]> {
  const parameters = new URLSearchParams({ query, provider });
  return responseTracks(
    await fetch(`${serverBaseUrl}/api/search/tracks?${parameters}`, { signal }),
  );
}
