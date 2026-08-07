import type { Track } from "../types/music";

const STREAMING_LIBRARY_CACHE_KEY = "ambra.streaming-library.v1";

function isCachedTrack(value: unknown): value is Track {
  if (typeof value !== "object" || value === null) return false;

  const track = value as Partial<Track>;
  return (
    typeof track.id === "string" &&
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
      ? parsed.filter(isCachedTrack).map((track) => ({
          ...track,
          nativeCover:
            typeof track.nativeCover === "string"
              ? track.nativeCover
              : track.cover,
        }))
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
