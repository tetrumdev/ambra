import { useEffect, useRef, type RefObject } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reducedMotion } from "../utils/reducedMotion";
import { enterNextViewFrom } from "../utils/viewMotion";
import "./NavigationSwipe.css";

type Direction = "back" | "forward";
type Gesture = {
  /** Finger travel in pixels: positive toward back, negative toward forward. */
  position: number;
  /** Travel per millisecond, signed like position and smoothed, for telling a flick from a slow drag. */
  velocity: number;
  time: number;
  ready: boolean;
  previousDelta: number;
  decreasing: number;
};
type Spring = { x: number; v: number };

const THRESHOLD = 110;
/** Travel stops here, where the arrow has all but stopped moving, so reversing responds at once. */
const MAX_TRAVEL = THRESHOLD * 1.6;
/** Backing off below this share of the threshold disarms it again; the gap stops haptic chatter. */
const DISARM = 0.8;
/** A quick flick commits once it has covered this share of the threshold. */
const FLICK_DISTANCE = 0.35;
const FLICK_VELOCITY = 0.7;
// Both follow the fingers with resistance from the start, the page far more than the arrow:
// the arrow is fully out (1) at the threshold and never passes ARROW_MAX; the page never passes PAGE_MAX px.
const ARROW_MAX = 1.25;
const ARROW_K = Math.atanh(1 / ARROW_MAX);
const PAGE_MAX = 28;
const PAGE_K = 0.6;
// The arrow is stiff and a little springy; the page is soft, so it trails behind.
const ARROW_SPRING = { stiffness: 520, damping: 34 };
const PAGE_SPRING = { stiffness: 140, damping: 22 };
/** Where the next page slides in from after a committed swipe. */
const ENTRY_OFFSET = 24;
const IDLE_MS = 100;
const RELEASE_MS = 260;
const MAC = isTauri() && navigator.userAgent.includes("Mac");

const resist = (progress: number, max: number, k: number) => Math.sign(progress) * max * Math.tanh(k * Math.abs(progress));
const haptic = () => { if (MAC) void invoke("trackpad_haptic").catch(() => {}); };

function step(spring: Spring, target: number, { stiffness, damping }: typeof ARROW_SPRING, dt: number) {
  spring.v += ((target - spring.x) * stiffness - spring.v * damping) * dt;
  spring.x += spring.v * dt;
}

// A shelf or field owns its whole gesture, even if it reaches its end midway through.
function ownsHorizontalScroll(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable='true'], [role='slider'], [role='spinbutton'], .columnResizeHandle, .eqGraph")) return true;
  for (let element: Element | null = target; element; element = element.parentElement) {
    if (element.scrollWidth > element.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(element).overflowX)) return true;
  }
  return false;
}

/** A horizontal trackpad swipe drags the page toward app history, then commits once on release. */
export function NavigationSwipe({ canNavigate, navigate, contextKey, screenRef }: {
  canNavigate: (direction: Direction) => boolean;
  navigate: (direction: Direction) => boolean;
  contextKey: string;
  /** The screen whose last child is the current page. */
  screenRef: RefObject<HTMLElement | null>;
}) {
  const indicatorRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<() => void>(() => {});
  useEffect(() => { cancelRef.current(); }, [contextKey]);

  useEffect(() => {
    let gesture: Gesture | null = null;
    let axis: "horizontal" | "other" | null = null;
    let locked = false;
    let nativePhases = false;
    let nativeContact = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let dismiss: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let lastFrame = 0;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Both keep moving after release, so a new swipe picks them up wherever they are.
    const arrow: Spring = { x: 0, v: 0 };
    const shift: Spring = { x: 0, v: 0 };
    let page: HTMLElement | null = null;

    function setReady(ready: boolean) {
      if (!gesture || gesture.ready === ready) return;
      gesture.ready = ready;
      if (indicatorRef.current) indicatorRef.current.dataset.ready = String(ready);
      haptic();
    }

    function render() {
      const indicator = indicatorRef.current;
      if (indicator) {
        const side = (arrow.x || gesture?.position || 0) < 0 ? "forward" : "back";
        if (indicator.dataset.direction !== side) indicator.dataset.direction = side;
        indicator.style.setProperty("--swipe-progress", Math.abs(arrow.x).toFixed(4));
        // Moving fast, the bubble stretches along its path and thins, then rounds out as it slows.
        indicator.style.setProperty("--swipe-stretch", Math.min(0.32, Math.abs(arrow.v) * 0.045).toFixed(4));
      }
      if (page) page.style.translate = `${shift.x.toFixed(2)}px`;
    }

    function animate(now: number) {
      frame = 0;
      const dt = Math.min(1 / 30, lastFrame ? (now - lastFrame) / 1000 : 1 / 60);
      lastFrame = now;
      const progress = (gesture?.position ?? 0) / THRESHOLD;
      const arrowTarget = resist(progress, ARROW_MAX, ARROW_K);
      if (reducedMotion()) {
        Object.assign(arrow, { x: arrowTarget, v: 0 });
        Object.assign(shift, { x: 0, v: 0 });
      } else {
        step(arrow, arrowTarget, ARROW_SPRING, dt);
        step(shift, resist(progress, PAGE_MAX, PAGE_K), PAGE_SPRING, dt);
      }
      render();
      if (!gesture && Math.abs(arrow.x) < 0.002 && Math.abs(arrow.v) < 0.02 && Math.abs(shift.x) < 0.1 && Math.abs(shift.v) < 2) {
        Object.assign(arrow, { x: 0, v: 0 });
        Object.assign(shift, { x: 0, v: 0 });
        if (page) page.style.translate = "";
        page = null;
        lastFrame = 0;
        if (indicatorRef.current) indicatorRef.current.dataset.state = "idle";
        return;
      }
      frame = requestAnimationFrame(animate);
    }

    function run() {
      if (!frame) frame = requestAnimationFrame(animate);
    }

    function finish(commit: boolean) {
      if (!gesture) return;
      const { position, ready, velocity, time } = gesture;
      const direction: Direction = position < 0 ? "forward" : "back";
      const distance = Math.abs(position);
      // A pause before lifting the fingers leaves no flick behind it.
      const flick = performance.now() - time < 60 && velocity * position > 0
        && Math.abs(velocity) >= FLICK_VELOCITY && distance >= THRESHOLD * FLICK_DISTANCE;
      const committed = commit && distance > 0 && (ready || flick) && canNavigate(direction) && navigate(direction);
      if (!committed) setReady(false);
      gesture = null;
      locked = true;
      if (!committed) { run(); return; }

      cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
      Object.assign(arrow, { x: 0, v: 0 });
      Object.assign(shift, { x: 0, v: 0 });
      const indicator = indicatorRef.current;
      if (indicator) {
        indicator.dataset.ready = "true";
        indicator.style.setProperty("--swipe-stretch", "0");
        indicator.dataset.state = "commit";
        clearTimeout(dismiss);
        dismiss = setTimeout(() => { if (!gesture && !frame) indicator.dataset.state = "idle"; }, RELEASE_MS);
      }
      const held = page;
      page = null;
      // The old page holds where the fingers left it until the next one slides in behind them.
      if (held) enterNextViewFrom(position > 0 ? -ENTRY_OFFSET : ENTRY_OFFSET, () => { held.style.translate = ""; });
    }

    function cancel() {
      if (gesture) {
        finish(false);
        axis = "other";
      } else if (!locked) {
        axis = null;
      }
    }
    cancelRef.current = cancel;

    function begin(time: number) {
      clearTimeout(dismiss);
      const screen = screenRef.current;
      const current = screen?.lastElementChild;
      const next = current instanceof HTMLElement && !screen?.hasAttribute("data-hidden") ? current : null;
      if (page && page !== next) page.style.translate = "";
      page = next;
      page?.getAnimations().forEach(animation => animation.finish());
      gesture = { position: 0, velocity: 0, time, ready: false, previousDelta: 0, decreasing: 0 };
      const indicator = indicatorRef.current;
      if (indicator) {
        if (indicator.dataset.state === "commit") indicator.style.setProperty("--swipe-progress", "0");
        indicator.dataset.ready = "false";
        indicator.dataset.state = "active";
      }
    }

    function handleWheel(event: WheelEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
        cancel();
        return;
      }
      clearTimeout(idle);
      // Wheel streams have no portable end event. Native phases or the browser's momentum
      // flag finish immediately; idle is the fallback, and always drains the remaining tail.
      idle = setTimeout(() => {
        if (!nativePhases) finish(true);
        axis = null;
        if (!nativePhases) locked = false;
      }, IDLE_MS);
      if (nativePhases && !nativeContact) {
        if (axis === "horizontal") event.preventDefault();
        return;
      }
      if (axis === null) {
        if (Math.abs(event.deltaX) + Math.abs(event.deltaY) < 2) return;
        axis = Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5 && !event.defaultPrevented && !ownsHorizontalScroll(event.target)
          ? "horizontal" : "other";
      }
      if (axis !== "horizontal") return;
      event.preventDefault();
      if (locked) return;
      if ((event as WheelEvent & { momentum?: boolean }).momentum) {
        finish(true);
        return;
      }
      const canBack = canNavigate("back");
      const canForward = canNavigate("forward");
      if (!gesture) {
        if (!event.deltaX || (!canBack && !canForward)) { locked = true; return; }
        begin(event.timeStamp);
      }
      const current = gesture!;
      // One position runs through zero: easing back follows the fingers, the arrow tucks away
      // at the start, and carrying on brings it out again, or out the other side when there is history there.
      const travel = -event.deltaX;
      current.position = Math.max(canForward ? -MAX_TRAVEL : 0, Math.min(canBack ? MAX_TRAVEL : 0, current.position + travel));
      const elapsed = Math.max(1, event.timeStamp - current.time);
      current.velocity = current.velocity * 0.5 + (travel / elapsed) * 0.5;
      current.time = event.timeStamp;
      // Older WebViews don't expose momentum. A sustained decay marks its onset;
      // freeze the threshold there so inertia cannot arm a short, unintended swipe.
      current.decreasing = event.deltaX * current.previousDelta > 0 && Math.abs(event.deltaX) < Math.abs(current.previousDelta) * 0.9
        ? current.decreasing + 1 : 0;
      current.previousDelta = event.deltaX;
      if (!nativePhases && !("momentum" in event) && current.decreasing >= 3) { finish(true); return; }
      const distance = Math.abs(current.position);
      // Crossing to the other side passes through zero, which always disarms first.
      setReady(current.ready ? distance >= THRESHOLD * DISARM : distance >= THRESHOLD);
      run();
    }

    if (MAC) {
      void listen<"began" | "ended" | "cancelled">("trackpad-phase", ({ payload }) => {
        nativePhases = true;
        clearTimeout(idle);
        if (payload === "began") {
          finish(false);
          nativeContact = true;
          locked = false;
          axis = null;
        } else {
          nativeContact = false;
          finish(payload === "ended");
        }
      }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    }

    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    const onVisibility = () => { if (document.hidden) cancel(); };
    window.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      unlisten?.();
      clearTimeout(idle);
      clearTimeout(dismiss);
      cancelAnimationFrame(frame);
      if (page) page.style.translate = "";
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
      cancelRef.current = () => {};
    };
  }, [canNavigate, navigate, screenRef]);

  return <div ref={indicatorRef} className="navigationSwipe" aria-hidden="true" data-state="idle" data-direction="back">
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 4.5-5.5 5.5 5.5 5.5" />
      <path className="navigationSwipeShaft" d="M4 10h12.5" pathLength={1} />
    </svg>
  </div>;
}
