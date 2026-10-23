import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./NavigationSwipe.css";

type Direction = "back" | "forward";
type Preview = { direction: Direction; progress: number; ready: boolean; releasing?: "commit" | "cancel" };
type Gesture = { distance: number; direction: Direction; previousDelta: number; decreasing: number };
const THRESHOLD = 120;
const IDLE_MS = 100;

// A shelf or field owns its whole gesture, even if it reaches its end midway through.
function ownsHorizontalScroll(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable='true'], [role='slider'], [role='spinbutton'], .columnResizeHandle, .eqGraph")) return true;
  for (let element: Element | null = target; element; element = element.parentElement) {
    if (element.scrollWidth > element.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(element).overflowX)) return true;
  }
  return false;
}

/** A horizontal trackpad gesture previews app history, then commits once on release. */
export function NavigationSwipe({ canNavigate, navigate, contextKey }: {
  canNavigate: (direction: Direction) => boolean;
  navigate: (direction: Direction) => boolean;
  contextKey: string;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
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
    let disposed = false;
    let unlisten: (() => void) | undefined;

    function finish(commit: boolean) {
      if (!gesture) return;
      const { direction, distance } = gesture;
      gesture = null;
      locked = true;
      cancelAnimationFrame(frame);
      frame = 0;
      const committed = commit && Math.abs(distance) >= THRESHOLD && canNavigate(direction) && navigate(direction);
      setPreview({ direction, progress: Math.min(1, Math.abs(distance) / THRESHOLD), ready: committed, releasing: committed ? "commit" : "cancel" });
      clearTimeout(dismiss);
      dismiss = setTimeout(() => setPreview(null), 180);
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

    function paint() {
      frame = 0;
      if (!gesture) return;
      setPreview({ direction: gesture.direction, progress: Math.min(1, Math.abs(gesture.distance) / THRESHOLD), ready: Math.abs(gesture.distance) >= THRESHOLD });
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
      const direction = event.deltaX < 0 ? "back" : "forward";
      if (!gesture) {
        if (!event.deltaX || !canNavigate(direction)) { locked = true; return; }
        clearTimeout(dismiss);
        gesture = { direction, distance: 0, previousDelta: 0, decreasing: 0 };
      }
      if (!canNavigate(gesture.direction)) { cancel(); return; }
      // Reversing disarms the swipe immediately, even after passing the threshold.
      // The rest of this gesture stays cancelled until a new one begins.
      if (event.deltaX !== 0 && direction !== gesture.direction) { cancel(); return; }
      // Older WebViews don't expose momentum. A sustained decay marks its onset;
      // freeze the threshold there so inertia cannot arm a short, unintended swipe.
      const magnitude = Math.abs(event.deltaX);
      const continuing = direction === gesture.direction;
      gesture.decreasing = continuing && magnitude < gesture.previousDelta * 0.9 ? gesture.decreasing + 1 : 0;
      gesture.previousDelta = magnitude;
      if (!nativePhases && !("momentum" in event) && gesture.decreasing >= 3) { finish(true); return; }
      gesture.distance = Math.max(-THRESHOLD * 1.5, Math.min(THRESHOLD * 1.5, gesture.distance + event.deltaX));
      if (!frame) frame = requestAnimationFrame(paint);
    }

    if (isTauri() && navigator.userAgent.includes("Mac")) {
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
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
      cancelRef.current = () => {};
    };
  }, [canNavigate, navigate]);

  if (!preview) return null;
  return <div className="navigationSwipe" aria-hidden="true" data-direction={preview.direction}
    data-ready={preview.ready} data-releasing={preview.releasing}
    style={{ "--swipe-progress": preview.progress } as CSSProperties}>
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 5-5 5 5 5M4 10h12" />
    </svg>
    <span>{preview.direction === "back" ? "Back" : "Forward"}</span>
  </div>;
}
