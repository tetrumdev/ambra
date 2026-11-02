/**
 * Ambra's "Animation frame rate" setting (Settings → Player). Caps how often the continuous
 * animations (lyrics, the swirl) repaint, to save power on high-refresh displays.
 * 0 means no cap: every display frame is drawn.
 */
let maxFps = 0;

export const ANIMATION_FPS_OPTIONS = [0, 144, 120, 60, 30] as const;

export function setMaxAnimationFps(value: number) {
  maxFps = Number.isFinite(value) && value > 0 ? value : 0;
}

/** The shortest time between two painted frames, or 0 when uncapped. */
export const animationFrameInterval = () => (maxFps ? 1000 / maxFps : 0);

/**
 * requestAnimationFrame that skips display frames to stay under the cap. One scheduler drives
 * one loop: `request` replaces any frame already waiting, and `cancel` stops it.
 */
export function createFrameScheduler() {
  let handle = 0;
  let last = 0;
  const cancel = () => {
    cancelAnimationFrame(handle);
    handle = 0;
  };
  const request = (callback: FrameRequestCallback) => {
    cancelAnimationFrame(handle);
    const tick = (now: number) => {
      const interval = animationFrameInterval();
      const since = now - last;
      // Half a millisecond of slack keeps a cap equal to the refresh rate from dropping frames.
      if (interval && last && since < interval - 0.5) {
        handle = requestAnimationFrame(tick);
        return;
      }
      handle = 0;
      // Carry the remainder so a 60 fps cap on a 144 Hz display averages 60, not 48.
      last = interval && since >= interval && since < interval * 2 ? now - (since - interval) : now;
      callback(now);
    };
    handle = requestAnimationFrame(tick);
    return 1;
  };
  return { request, cancel };
}
