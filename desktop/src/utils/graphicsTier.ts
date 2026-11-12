/**
 * What this device's graphics can afford. Nothing here is a setting: a capable machine keeps
 * every effect, and a weak one (an old Chromebook, a Raspberry Pi, a machine drawing without
 * a GPU) sheds the costly ones by itself so the app stays smooth. Stylesheets read the low
 * tier as `:root[data-graphics="low"]` (lowGraphics.css).
 */
let low = false;

export const lowGraphics = () => low;

/** Kept for the session: effects never flicker back on and off as load comes and goes. */
export function setLowGraphics() {
  if (low) return;
  low = true;
  document.documentElement.setAttribute("data-graphics", "low");
}

/** Drawing on the processor rather than a GPU, where every blurred pixel is paid for in full. */
export function softwareRendered(gl: WebGLRenderingContextBase) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  if (!info) return false;
  const renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "");
  return /llvmpipe|softpipe|swiftshader|software|basic render/i.test(renderer);
}

/**
 * Looks once, shortly after startup, at what draws the page. A machine without a GPU is
 * known to be weak before anything stutters; the rest are judged by how they keep up
 * (createSwirlPacing).
 */
export function detectGraphicsTier() {
  setTimeout(() => {
    try {
      const gl = document.createElement("canvas").getContext("webgl", { failIfMajorPerformanceCaveat: false });
      if (!gl) return;
      if (softwareRendered(gl)) {
        setLowGraphics();
        sizeIndex = SWIRL_SIZES.length - 1;
        settled = true;
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // No WebGL to ask: the swirl won't draw either, and the effects stay as they are.
    }
  }, 1500);
}

/** The long side of the swirl's canvas, in pixels, from full quality down to the floor. */
const SWIRL_SIZES = [960, 720, 540, 400];
/** Drawn frames measured before judging a size; the first few after a change are warm-up. */
const PACING_WINDOW = 45;
const PACING_WARMUP = 10;
/** A gap this long is a hiccup elsewhere (a hidden window, a loading song), not the pace. */
const PACING_HICCUP_MS = 250;
/** Frames this much slower than asked for mean the device isn't keeping up. */
const SLOW_RATIO = 1.4;
/** A smaller canvas must buy at least this much, or the swirl was never the cause. */
const IMPROVED_RATIO = 0.85;
/** Slow windows in a row at the smallest size before the whole app goes easy on effects. */
const SLOW_WINDOWS_AT_FLOOR = 2;

// Learned once per run and shared by every swirl, so reopening the player doesn't relearn it.
let sizeIndex = 0;
let settled = false;
let slowAtFloor = 0;
/** The pace at the previous, larger size, while a step down is on trial. */
let paceBeforeStep: number | null = null;

export const swirlCanvasLimit = () => SWIRL_SIZES[sizeIndex];

/**
 * Follows the swirl's frame pacing and shrinks its canvas when the device falls behind.
 * The field has no fine detail, so a smaller canvas stretched over the window looks the
 * same; its cost falls with the pixel count. `frame` takes each drawn frame's time and the
 * interval the swirl aims for, and returns true when the canvas size has changed.
 */
export function createSwirlPacing() {
  let previous = 0;
  let skip = PACING_WARMUP;
  const intervals: number[] = [];
  const restart = () => {
    previous = 0;
    skip = PACING_WARMUP;
    intervals.length = 0;
  };
  const frame = (now: number, target: number) => {
    if (settled) return false;
    const interval = previous ? now - previous : 0;
    previous = now;
    if (!interval) return false;
    if (interval > PACING_HICCUP_MS) { restart(); return false; }
    if (skip > 0) { skip--; return false; }
    intervals.push(interval);
    if (intervals.length < PACING_WINDOW) return false;
    const pace = intervals.sort((a, b) => a - b)[intervals.length >> 1];
    restart();
    const slow = pace > target * SLOW_RATIO;
    if (paceBeforeStep !== null) {
      const improved = pace < paceBeforeStep * IMPROVED_RATIO;
      paceBeforeStep = null;
      if (!improved) {
        // Something else sets the pace (a slow display, a busy machine): give the detail back.
        sizeIndex--;
        settled = true;
        return true;
      }
    }
    if (!slow) {
      slowAtFloor = 0;
      return false;
    }
    if (sizeIndex < SWIRL_SIZES.length - 1) {
      paceBeforeStep = pace;
      sizeIndex++;
      return true;
    }
    if (++slowAtFloor >= SLOW_WINDOWS_AT_FLOOR) {
      setLowGraphics();
      settled = true;
    }
    return false;
  };
  return { frame, restart };
}
