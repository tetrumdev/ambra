// The now-playing bar's small cover is hidden by the time the player opens, so its
// last position is kept here for the player cover to grow out of.
let rect: DOMRect | null = null;

export function observeCompactArtwork(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return;
  // A detached or hidden thumbnail measures empty; keep its last real place instead.
  const measure = () => {
    // Only the compact bar shows it; the expanded bar keeps it hidden out of the layout.
    if (!element.closest('[data-variant="compact"]')) return;
    const next = element.getBoundingClientRect();
    if (next.width) rect = next;
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  window.addEventListener("resize", measure);
  return () => {
    measure();
    observer.disconnect();
    window.removeEventListener("resize", measure);
  };
}

/** Records where the thumbnail is just before the bar leaves its compact layout. */
export function rememberCompactArtwork() {
  const next = document.querySelector('[data-variant="compact"] #compactArtwork')?.getBoundingClientRect();
  if (next?.width) rect = next;
}

export function compactArtworkRect(): DOMRect | null {
  return document.querySelector('[data-variant="compact"] #compactArtwork')?.getBoundingClientRect() ?? rect;
}
