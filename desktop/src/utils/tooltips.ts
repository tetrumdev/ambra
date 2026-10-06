// The app's own tooltips. Native `title` tooltips are drawn by the WebView and
// give away that the app is web-based, so elements opt in with
// `data-tooltip="Text"` instead. `data-tooltip-overflow` shows the tooltip only
// while the element's text is cut off (long titles).
//
// They behave like the system's: a tooltip appears only once the pointer has
// rested on a control, sits just below the cursor rather than over the
// neighboring controls, and stays away after a click until the pointer leaves.
//
// One element is reused for every tooltip and driven from delegated listeners,
// so hovering never re-renders React.

import "./tooltips.css";

const REST_DELAY_MS = 900;
// Right after a tooltip closes, the next control's tooltip only needs a brief rest.
const WARM_DELAY_MS = 120;
const WARM_WINDOW_MS = 600;
// Pointer jitter below this distance still counts as resting.
const REST_TOLERANCE = 3;
// Clears the cursor's own shape.
const CURSOR_HEIGHT = 20;
const GAP = 6;
const EDGE = 8;

type Size = { width: number; height: number };

/** A cursor hotspot, or a focused control's horizontal center and edges. */
export type TooltipTarget = { x: number; top: number; bottom: number; align: "cursor" | "center" };

export type TooltipPlacement = { left: number; top: number };

/** Below the target (beneath the cursor, or under a focused control), above it when there is no room. */
export function placeTooltip(target: TooltipTarget, tooltip: Size, viewport: Size): TooltipPlacement {
  const below = target.align === "cursor" ? target.top + CURSOR_HEIGHT : target.bottom + GAP;
  const top = below + tooltip.height <= viewport.height - EDGE ? below : target.top - GAP - tooltip.height;
  const preferred = target.align === "cursor" ? target.x : target.x - tooltip.width / 2;
  const left = Math.min(Math.max(preferred, EDGE), Math.max(EDGE, viewport.width - EDGE - tooltip.width));
  return { left: Math.round(left), top: Math.round(Math.max(EDGE, top)) };
}

function isTruncated(element: HTMLElement) {
  return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
}

function tooltipAnchor(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") : null;
}

function focusTarget(element: HTMLElement): TooltipTarget {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom, align: "center" };
}

export function installTooltips(): () => void {
  const bubble = document.createElement("div");
  bubble.className = "ambraTooltip";
  bubble.setAttribute("role", "tooltip");
  bubble.setAttribute("aria-hidden", "true");
  document.body.append(bubble);

  let anchor: HTMLElement | null = null;
  let target: TooltipTarget | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visible = false;
  let hiddenAt = -Infinity;
  // The control just clicked; it stays quiet until the pointer leaves it.
  let suppressed: HTMLElement | null = null;

  const show = () => {
    timer = undefined;
    if (!anchor?.isConnected || !target) return;
    const text = anchor.dataset.tooltip?.trim();
    if (!text || ("tooltipOverflow" in anchor.dataset && !isTruncated(anchor))) return;
    bubble.textContent = text;
    const placement = placeTooltip(
      target,
      { width: bubble.offsetWidth, height: bubble.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    bubble.style.transform = `translate(${placement.left}px, ${placement.top}px)`;
    bubble.dataset.shown = "";
    visible = true;
  };

  const restart = () => {
    clearTimeout(timer);
    const warm = performance.now() - hiddenAt < WARM_WINDOW_MS;
    timer = setTimeout(show, warm ? WARM_DELAY_MS : REST_DELAY_MS);
  };

  const hide = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!visible) return;
    visible = false;
    hiddenAt = performance.now();
    delete bubble.dataset.shown;
  };

  const forget = () => {
    hide();
    anchor = null;
    target = null;
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch" || event.buttons !== 0) return;
    const next = tooltipAnchor(event.target);
    if (suppressed && next !== suppressed) suppressed = null;
    if (next !== anchor) {
      forget();
      if (!next || next === suppressed) return;
      anchor = next;
    } else if (visible || !anchor || anchor === suppressed) {
      return;
    } else if (
      target
      && Math.abs(event.clientX - target.x) < REST_TOLERANCE
      && Math.abs(event.clientY - target.top) < REST_TOLERANCE
    ) {
      return;
    }
    // Still moving: the tooltip waits until the pointer settles.
    target = { x: event.clientX, top: event.clientY, bottom: event.clientY, align: "cursor" };
    restart();
  };

  const onPointerOut = (event: PointerEvent) => {
    const to = event.relatedTarget;
    if (suppressed && !(to instanceof Node && suppressed.contains(to))) suppressed = null;
    if (!anchor || (to instanceof Node && anchor.contains(to))) return;
    forget();
  };

  const onPointerDown = () => {
    suppressed = anchor;
    forget();
  };

  const onFocusIn = (event: FocusEvent) => {
    const next = tooltipAnchor(event.target);
    if (!next || !next.matches(":focus-visible")) return;
    forget();
    anchor = next;
    target = focusTarget(next);
    restart();
  };

  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerout", onPointerOut, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", forget, true);
  // Typing, scrolling, or leaving the window makes a tooltip stale.
  document.addEventListener("keydown", forget, true);
  document.addEventListener("wheel", forget, { capture: true, passive: true });
  document.addEventListener("scroll", forget, true);
  window.addEventListener("blur", forget);

  return () => {
    forget();
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerout", onPointerOut, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", forget, true);
    document.removeEventListener("keydown", forget, true);
    document.removeEventListener("wheel", forget, true);
    document.removeEventListener("scroll", forget, true);
    window.removeEventListener("blur", forget);
    bubble.remove();
  };
}
