import type { MouseEvent } from "react";
import { motion } from "./motion";

const running = new WeakMap<HTMLDetailsElement, Animation>();

/**
 * A summary's click handler that slides its group open and closed instead of snapping.
 * Opening shows the contents at once and grows them into place; closing shrinks them
 * first and only then closes the group, so its toggle event still reports each change.
 */
export function slideDetails(event: MouseEvent<HTMLElement>) {
  const details = event.currentTarget.parentElement;
  if (!(details instanceof HTMLDetailsElement)) return;
  const body = details.querySelector<HTMLElement>(":scope > :not(summary)");
  if (!body || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  event.preventDefault();
  const previous = running.get(details);
  // Turning back mid-slide picks up from the height on screen.
  const from = previous ? body.getBoundingClientRect().height : null;
  previous?.cancel();
  const closing = details.open && details.dataset.closing === undefined;
  if (closing) details.dataset.closing = "";
  else {
    delete details.dataset.closing;
    details.open = true;
  }
  const full = body.scrollHeight;
  const start = from ?? (closing ? full : 0);
  const end = closing ? 0 : full;
  // The contents' vertical margins and padding fold with them, so nothing jumps when the group finally opens or closes.
  const style = getComputedStyle(body);
  const spacing = ["marginTop", "marginBottom", "paddingTop", "paddingBottom"] as const;
  const at = (share: number) => Object.fromEntries(spacing.map(property => [property, `${parseFloat(style[property]) * share}px`]));
  const share = (height: number) => Math.min(1, height / Math.max(1, full));
  body.style.overflow = "hidden";
  const slide = body.animate(
    [
      // The measured height includes padding, so the animated one must too.
      { boxSizing: "border-box", height: `${start}px`, opacity: share(start), ...at(share(start)) },
      { boxSizing: "border-box", height: `${end}px`, opacity: closing ? 0 : 1, ...at(closing ? 0 : 1) },
    ],
    motion.snappy,
  );
  running.set(details, slide);
  slide.onfinish = () => {
    running.delete(details);
    body.style.overflow = "";
    if (!closing) return;
    delete details.dataset.closing;
    details.open = false;
  };
}
