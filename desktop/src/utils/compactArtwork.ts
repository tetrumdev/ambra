// The now-playing bar's small cover is gone by the time the player opens, so its
// last position is kept here for the player cover to grow out of.
let rect: DOMRect | null = null;

export function observeCompactArtwork(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return;
  const measure = () => { rect = element.getBoundingClientRect(); };
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

export function compactArtworkRect(): DOMRect | null {
  return document.getElementById("compactArtwork")?.getBoundingClientRect() ?? rect;
}
