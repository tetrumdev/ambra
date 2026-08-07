import type { PlaybackKind } from "../types/music";

const HAVE_FUTURE_DATA = 3;

export function canAttemptPlayback(
  playbackKind: PlaybackKind | null,
  readyState: number,
) {
  return playbackKind !== "dash" || readyState >= HAVE_FUTURE_DATA;
}
