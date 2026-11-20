import { motion } from "./motion";
import { reducedMotion } from "./reducedMotion";

let pendingEntry: { offset: number; release: () => void; timer: ReturnType<typeof setTimeout> } | null = null;

function takeEntry() {
  const entry = pendingEntry;
  if (!entry) return null;
  pendingEntry = null;
  clearTimeout(entry.timer);
  entry.release();
  return entry;
}

/** The next screen slides in sideways from `offset` pixels, continuing a swipe. `release` runs
    as it arrives, so the page it replaces holds where the swipe left it until then. */
export function enterNextViewFrom(offset: number, release: () => void) {
  takeEntry();
  // Not every history step changes screens; a swap that never arrives releases on its own.
  pendingEntry = { offset, release, timer: setTimeout(takeEntry, 250) };
}

/** A screen arriving rises a few pixels into place as it fades in; the one it replaced is already gone. */
export function enterView(element: Element | null | undefined) {
  const entry = takeEntry();
  if (!element || reducedMotion()) return;
  element.animate(
    [{ opacity: 0, transform: entry ? `translateX(${entry.offset}px)` : "translateY(10px)" }, { opacity: 1, transform: "none" }],
    motion.enter,
  );
}

const STAGGER_MS = 25;
const MAX_STAGGER_MS = 240;

/** The rows in view settle in one after another, top first; rows out of view are left alone. */
export function staggerRows(container: Element, selector: string) {
  if (reducedMotion()) return;
  const bottom = container.getBoundingClientRect().bottom;
  let index = 0;
  for (const row of container.querySelectorAll<HTMLElement>(selector)) {
    const top = row.getBoundingClientRect().top;
    if (top > bottom) break;
    row.animate(
      [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
      { ...motion.enter, delay: Math.min(index++ * STAGGER_MS, MAX_STAGGER_MS), fill: "backwards" },
    );
  }
}
