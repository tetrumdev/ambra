import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type DesktopPlatform = "windows" | "linux" | "other";

export function desktopPlatform(userAgent = navigator.userAgent): DesktopPlatform {
  if (userAgent.includes("Windows")) return "windows";
  if (userAgent.includes("Linux") && !userAgent.includes("Android")) return "linux";
  return "other";
}

/**
 * On Windows the window's focus event is the page itself gaining focus, so handing focus
 * back to the page there makes WebView2 cycle focus and report it again, in a loop that
 * starves the window's thread (dragging the window stops working).
 */
export function pageNeedsFocusOnActivation(platform = desktopPlatform()) {
  return platform !== "windows";
}

/** Only macOS draws the window's title bar inside the page; Windows and Linux keep their native one. */
export function canUseWindowDragRegion(
  platform: DesktopPlatform,
  isFullscreen: boolean | null,
) {
  return platform === "other" && isFullscreen === false;
}

type DragRegion = { x: number; y: number; width: number; height: number };

/** How close to the top, in pixels, the pointer is near enough to press a strip next. */
const NEAR_STRIPS = 64;
const SAMPLE_STEP = 8;

/**
 * The parts of the title bar strips (`data-window-drag-region`) with nothing lying over them,
 * such as the search field. Each half of a strip's height is judged along its middle line.
 */
function exposedDragRegions() {
  const regions: DragRegion[] = [];
  for (const strip of document.querySelectorAll<HTMLElement>("[data-window-drag-region]")) {
    const box = strip.getBoundingClientRect();
    const left = Math.max(0, box.left);
    const right = Math.min(window.innerWidth, box.right);
    const height = box.height / 2;
    if (height <= 0 || right - left < 1) continue;
    for (const top of [box.top, box.top + height]) {
      const exposed = (x: number) => document.elementFromPoint(x, top + height / 2) === strip;
      const samples: number[] = [];
      for (let x = left; x < right - 1; x += SAMPLE_STEP) samples.push(x);
      samples.push(right - 1);
      let start = left;
      let last = left;
      let wasExposed = false;
      for (const x of samples) {
        const isExposed = exposed(x);
        if (isExposed !== wasExposed) {
          // Narrow the change between the two samples down to a pixel.
          let before = last;
          let after = x;
          while (after - before > 1) {
            const middle = (before + after) / 2;
            if (exposed(middle) === wasExposed) before = middle;
            else after = middle;
          }
          if (isExposed) start = x === left ? left : after;
          else regions.push({ x: start, y: top, width: before - start, height });
        }
        last = x;
        wasExposed = isExposed;
      }
      if (wasExposed) regions.push({ x: start, y: top, width: right - start, height });
    }
  }
  return regions;
}

/**
 * Moves the window from the title bar strips macOS draws in the page (`data-window-drag-region`),
 * and zooms it on a double click there, as its native title bar does.
 *
 * Where the window server starts the drag itself, it does so before the page sees the press,
 * so the page reports ahead of time which parts of the strips are free to drag by; see
 * `window_drag.rs`. Elsewhere the press on a strip asks for the drag.
 */
export function installWindowDragRegions(platform = desktopPlatform()) {
  if (!isTauri() || platform !== "other") return;
  const isRegion = (target: EventTarget | null) =>
    target instanceof HTMLElement && target.hasAttribute("data-window-drag-region");
  let serverStartsDrags = false;
  let zoomFrom: { x: number; y: number } | null = null;
  document.addEventListener("mousedown", event => {
    if (event.button !== 0 || !isRegion(event.target)) return;
    event.preventDefault();
    if (event.detail === 2) {
      // Zoom on release, so moving away cancels it.
      zoomFrom = { x: event.clientX, y: event.clientY };
      return;
    }
    if (event.detail === 1 && !serverStartsDrags) void invoke("start_window_drag").catch(() => {});
  });
  document.addEventListener("mouseup", event => {
    const from = zoomFrom;
    zoomFrom = null;
    if (!from || event.button !== 0 || !isRegion(event.target)) return;
    if (event.clientX === from.x && event.clientY === from.y) void getCurrentWindow().toggleMaximize().catch(() => {});
  });

  let reported = "";
  let frame = 0;
  const report = () => {
    frame = 0;
    const message = { viewportWidth: window.innerWidth, regions: exposedDragRegions() };
    const next = JSON.stringify(message);
    if (next === reported) return;
    reported = next;
    invoke<boolean>("set_window_drag_regions", message).then(
      needed => {
        serverStartsDrags = needed;
        if (!needed) stop();
      },
      () => { reported = ""; },
    );
  };
  const schedule = () => { frame ||= requestAnimationFrame(report); };
  // The strips' shape only matters once the pointer can press them. Until it first moves, it may
  // already be resting there.
  let near = true;
  const moved = (event: MouseEvent) => {
    near = event.clientY < NEAR_STRIPS;
    if (near) schedule();
  };
  const left = () => { near = false; };
  const acted = () => { if (near) schedule(); };
  // The page can change under a resting pointer with no event to show for it.
  const poll = window.setInterval(() => {
    if (near && document.visibilityState === "visible") schedule();
  }, 400);
  const stop = () => {
    window.clearInterval(poll);
    document.removeEventListener("mousemove", moved);
    document.documentElement.removeEventListener("mouseleave", left);
    document.removeEventListener("mouseup", acted, true);
    document.removeEventListener("keyup", acted, true);
    window.removeEventListener("resize", schedule);
  };
  document.addEventListener("mousemove", moved, { passive: true });
  document.documentElement.addEventListener("mouseleave", left);
  document.addEventListener("mouseup", acted, true);
  document.addEventListener("keyup", acted, true);
  window.addEventListener("resize", schedule);
  schedule();
}
