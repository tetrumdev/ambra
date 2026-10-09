import { useSyncExternalStore } from "react";

// Playback position changes several times a second. Holding it in React state
// rerenders the whole app on every tick; this store lets only the components
// that show the position subscribe to it.
export type PlaybackClock = {
  get: () => number;
  set: (time: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createPlaybackClock(): PlaybackClock {
  let time = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => time,
    set: (next) => {
      if (next === time) return;
      time = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Rerenders only when `select(time)` changes, e.g. a whole-second value. */
export function usePlaybackTime<T = number>(
  clock: PlaybackClock,
  select: (time: number) => T = (time) => time as T,
): T {
  return useSyncExternalStore(clock.subscribe, () => select(clock.get()), () => select(clock.get()));
}
