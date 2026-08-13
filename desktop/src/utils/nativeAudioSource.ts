import type { Track } from "../types/music";

export function nativeAudioSource(track: Track) {
  if (track.provider === "local") return track.providerTrackId;
  if (track.playbackKind === "dash") {
    return track.audio.replace(/\/manifest\.mpd(?=\?|$)/, "/playlist.m3u8");
  }
  return track.audio;
}

export function nativeAudioQueue(tracks: Track[], currentTrackId: string) {
  const currentIndex = tracks.findIndex(
    (track) => track.globalId === currentTrackId,
  );
  if (currentIndex < 0) return null;

  const currentTrack = tracks[currentIndex];
  const nextTrack = tracks[(currentIndex + 1) % tracks.length];
  return {
    source: nativeAudioSource(currentTrack),
    nextSource: nativeAudioSource(nextTrack),
  };
}

export function trackForNativeAudioSource(tracks: Track[], source: string) {
  return tracks.find((track) => nativeAudioSource(track) === source);
}

export function trackForNativeAudioStatus(
  tracks: Track[],
  currentTrackId: string | null,
  nextTrack: Track | undefined,
  currentSource: string | null,
) {
  if (!currentSource) return undefined;

  const currentTrack = tracks.find(
    (track) => track.globalId === currentTrackId,
  );
  if (
    currentTrack &&
    nativeAudioSource(currentTrack) === currentSource
  ) {
    return { track: currentTrack, advanced: false };
  }

  const sourceTrack = trackForNativeAudioSource(tracks, currentSource);
  if (!sourceTrack || sourceTrack.globalId !== nextTrack?.globalId) {
    return undefined;
  }
  return { track: sourceTrack, advanced: true };
}
