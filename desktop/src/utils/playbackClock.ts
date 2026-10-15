import { useSyncExternalStore } from "react";

// Playback position changes several times a second. Holding it in React state
// rerenders the whole app on every tick; this store lets only the components
// that show the position subscribe to it.
export type PlaybackClock = {
  get: () => number;
  /** Frame-resolution time; discrete get() remains stable for React subscribers. */
  getSmooth: () => number;
  setRunning: (running: boolean) => void;
  set: (time: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createPlaybackClock(): PlaybackClock {
  let time = 0;
  let sampledAt = performance.now();
  let running = false;
  const smooth = () => time + (running ? Math.min(0.25, Math.max(0, performance.now() - sampledAt) / 1000) : 0);
  const listeners = new Set<() => void>();
  return {
    get: () => time,
    getSmooth: smooth,
    setRunning: (next) => {
      if (running === next) return;
      time = smooth();
      sampledAt = performance.now();
      running = next;
      for (const listener of listeners) listener();
    },
    set: (next) => {
      const changed = next !== time;
      time = next;
      sampledAt = performance.now();
      if (!changed) return;
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
