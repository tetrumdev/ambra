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

// Samples can arrive late or irregularly, especially while the app is busy loading a
// new song. The smooth clock keeps advancing at playback rate between them and blends
// small disagreements in, instead of stalling and then jumping to each sample.
/** Disagreements beyond this are seeks or stalls and are applied at once. */
const SNAP_SECONDS = 0.35;
/** Small disagreements are absorbed over this long. Must exceed SNAP_SECONDS to stay monotonic. */
const CORRECTION_SECONDS = 0.4;
/** Without any sample for this long, the clock stops rather than run past a stall. */
const MAX_EXTRAPOLATION_SECONDS = 1.5;

export function createPlaybackClock(): PlaybackClock {
  /** The latest reported position. */
  let time = 0;
  let running = false;
  // Smooth position: base, plus running time since anchoredAt, plus a correction blended in.
  let base = 0;
  let correction = 0;
  let anchoredAt = performance.now();
  const smoothAt = (now: number) => {
    if (!running) return base + correction;
    const elapsed = Math.min(MAX_EXTRAPOLATION_SECONDS, Math.max(0, now - anchoredAt) / 1000);
    return base + elapsed + correction * Math.min(1, elapsed / CORRECTION_SECONDS);
  };
  const anchor = (now: number, position: number, pending = 0) => {
    base = position;
    correction = pending;
    anchoredAt = now;
  };
  const listeners = new Set<() => void>();
  return {
    get: () => time,
    getSmooth: () => smoothAt(performance.now()),
    setRunning: (next) => {
      if (running === next) return;
      const now = performance.now();
      time = smoothAt(now);
      anchor(now, time);
      running = next;
      for (const listener of listeners) listener();
    },
    set: (next) => {
      const changed = next !== time;
      time = next;
      const now = performance.now();
      const current = smoothAt(now);
      const error = next - current;
      if (!running || Math.abs(error) > SNAP_SECONDS) anchor(now, next);
      else anchor(now, current, error);
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
