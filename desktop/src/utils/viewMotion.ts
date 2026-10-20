import { motion } from "./motion";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A screen arriving rises a few pixels into place as it fades in; the one it replaced is already gone. */
export function enterView(element: Element | null | undefined) {
  if (!element || reducedMotion()) return;
  element.animate(
    [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
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
