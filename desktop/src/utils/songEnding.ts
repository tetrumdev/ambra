import { usePlaybackTime, type PlaybackClock } from "./playbackClock";

/**
 * In a song's last seconds nothing starts animating on its own, so the next song's arrival
 * plays out undisturbed. Longer than the slowest automatic move (motion.drift) with room to spare.
 */
export const SONG_ENDING_SECONDS = 5;

export function isSongEnding(time: number, durationSeconds: number | undefined) {
  return durationSeconds !== undefined && durationSeconds > 0 && durationSeconds - time <= SONG_ENDING_SECONDS;
}

/** True through the current song's last few seconds; rerenders only when that changes. */
export function useSongEnding(clock: PlaybackClock, durationSeconds: number | undefined) {
  return usePlaybackTime(clock, (time) => isSongEnding(time, durationSeconds));
}
