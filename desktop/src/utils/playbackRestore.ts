import type { Track } from "../types/music";

export function playbackRestore(
  tracks: Track[],
  saved: { trackId: string | null; positionSeconds: number },
) {
  const track = saved.trackId === null
    ? tracks[0]
    : tracks.find((candidate) => candidate.globalId === saved.trackId);
  if (!track) return null;
  const position = saved.trackId === null ? 0 : saved.positionSeconds;
  return {
    track,
    position: track.durationSeconds > 0
      ? Math.min(position, track.durationSeconds)
      : position,
  };
}
