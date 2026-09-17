const callbacks = new Map<Element, () => void>();
let observer: IntersectionObserver | undefined;

// Start missing-portrait searches well before the card enters view, but avoid
// queuing an entire library's catalog searches on the first render.
export function observeNearbyArtwork(element: Element, ready: () => void) {
  if (typeof IntersectionObserver === "undefined") {
    ready();
    return () => {};
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const callback = callbacks.get(entry.target);
      callbacks.delete(entry.target);
      observer?.unobserve(entry.target);
      callback?.();
    }
  }, { rootMargin: "1200px" });
  callbacks.set(element, ready);
  observer.observe(element);
  return () => {
    callbacks.delete(element);
    observer?.unobserve(element);
    if (!callbacks.size) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}
