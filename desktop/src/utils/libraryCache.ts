import type { GlobalTrackId, Track } from "../types/music";

const STREAMING_LIBRARY_CACHE_KEY = "ambra.streaming-library.v1";
const REMOVED_LIBRARY_TRACKS_KEY = "ambra.removed-library-tracks.v1";

type CachedTrack = Omit<Track, "globalId"> & {
  globalId?: string;
  id?: string;
};

function isCachedTrack(value: unknown): value is CachedTrack {
  if (typeof value !== "object" || value === null) return false;

  const track = value as Partial<CachedTrack>;
  return (
    (typeof track.globalId === "string" || typeof track.id === "string") &&
    typeof track.provider === "string" &&
    track.provider !== "local" &&
    typeof track.providerTrackId === "string" &&
    (track.playbackKind === "direct" || track.playbackKind === "dash") &&
    typeof track.audio === "string" &&
    typeof track.cover === "string" &&
    typeof track.name === "string" &&
    typeof track.album === "string" &&
    typeof track.artist === "string" &&
    Array.isArray(track.artists) &&
    typeof track.durationSeconds === "number"
  );
}

export function parseCachedServerTracks(value: string | null): Track[] {
  if (value === null) return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(isCachedTrack).map((track) => {
          const { id: legacyId, ...cachedTrack } = track;

          return {
            ...cachedTrack,
            globalId: track.globalId ?? legacyId!,
            nativeCover:
              typeof track.nativeCover === "string"
                ? track.nativeCover
                : track.cover,
            version: track.version ?? null,
            albumVersion: track.albumVersion ?? null,
            albumArtists: Array.isArray(track.albumArtists)
              ? track.albumArtists.map((artist) => ({
                  ...artist,
                  imageUrl: artist.imageUrl ?? null,
                }))
              : [],
            artists: track.artists.map((artist) => ({
              ...artist,
              imageUrl: artist.imageUrl ?? null,
            })),
            copyright: track.copyright ?? null,
            label: track.label ?? null,
            genres: Array.isArray(track.genres) ? track.genres : [],
            upc: track.upc ?? null,
            maximumSamplingRateKHz: track.maximumSamplingRateKHz ?? null,
            maximumBitDepth: track.maximumBitDepth ?? null,
          };
        })
      : [];
  } catch {
    return [];
  }
}

export function loadCachedServerTracks(): Track[] {
  if (typeof localStorage === "undefined") return [];

  try {
    return parseCachedServerTracks(
      localStorage.getItem(STREAMING_LIBRARY_CACHE_KEY),
    );
  } catch {
    return [];
  }
}

export function saveCachedServerTracks(tracks: Track[]) {
  if (typeof localStorage === "undefined") return;

  try {
    localStorage.setItem(
      STREAMING_LIBRARY_CACHE_KEY,
      JSON.stringify(tracks.filter((track) => track.provider !== "local")),
    );
  } catch {
    // A storage quota or privacy setting should not prevent library playback.
  }
}

export function parseRemovedLibraryTrackIds(
  value: string | null,
): GlobalTrackId[] {
  if (value === null) return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];

    return [...new Set(parsed.filter((trackId) => typeof trackId === "string"))];
  } catch {
    return [];
  }
}

export function loadRemovedLibraryTrackIds(): Set<GlobalTrackId> {
  if (typeof localStorage === "undefined") return new Set();

  try {
    return new Set(
      parseRemovedLibraryTrackIds(
        localStorage.getItem(REMOVED_LIBRARY_TRACKS_KEY),
      ),
    );
  } catch {
    return new Set();
  }
}

export function saveRemovedLibraryTrackIds(trackIds: Set<GlobalTrackId>) {
  if (typeof localStorage === "undefined") return;

  try {
    localStorage.setItem(
      REMOVED_LIBRARY_TRACKS_KEY,
      JSON.stringify([...trackIds]),
    );
  } catch {
    // A storage quota or privacy setting should not prevent library playback.
  }
}
