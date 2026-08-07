import type { MusicProvider, Track } from "../types/music";

export type PlaybackCacheTrack = {
  provider: MusicProvider;
  providerTrackId: string;
  durationSeconds: number;
};

export type PlaybackCachePlan = {
  current: PlaybackCacheTrack | null;
  upcoming: PlaybackCacheTrack[];
};

type CachePlannableTrack = Pick<
  Track,
  "id" | "provider" | "providerTrackId" | "durationSeconds"
>;

function cacheTrack(track: CachePlannableTrack): PlaybackCacheTrack | null {
  if (track.provider !== "tidal" && track.provider !== "qobuz") return null;
  return {
    provider: track.provider,
    providerTrackId: track.providerTrackId,
    durationSeconds: track.durationSeconds,
  };
}

export function playbackCachePlan(
  tracks: CachePlannableTrack[],
  currentTrackId: string | null,
): PlaybackCachePlan {
  const currentIndex = tracks.findIndex((track) => track.id === currentTrackId);
  if (currentIndex < 0) return { current: null, upcoming: [] };

  const upcoming: PlaybackCacheTrack[] = [];
  const positionCount = Math.min(3, tracks.length - 1);
  for (let offset = 1; offset <= positionCount; offset += 1) {
    const track = tracks[(currentIndex + offset) % tracks.length];
    const payload = cacheTrack(track);
    if (payload) upcoming.push(payload);
  }

  return {
    current: cacheTrack(tracks[currentIndex]),
    upcoming,
  };
}

export const emptyPlaybackCachePlan: PlaybackCachePlan = {
  current: null,
  upcoming: [],
};
