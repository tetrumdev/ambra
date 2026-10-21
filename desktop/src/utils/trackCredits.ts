import { useSyncExternalStore } from "react";
import type { Track } from "../types/music";

// Any track menu can open the one credits dialog App shows.
let shown: Track | null = null;
const listeners = new Set<() => void>();

export function showTrackCredits(track: Track | null) {
  shown = track;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useShownTrackCredits() {
  return useSyncExternalStore(subscribe, () => shown);
}

/** "1, 3–5, 9": the tracks a contributor is on. */
export function trackRanges(tracks: number[]) {
  const ranges: string[] = [];
  for (let index = 0; index < tracks.length; index++) {
    const start = tracks[index];
    while (tracks[index + 1] === tracks[index] + 1) index++;
    ranges.push(tracks[index] === start ? `${start}` : `${start}–${tracks[index]}`);
  }
  return ranges.join(", ");
}
