import { createElement, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

const FADE_MS = 150;

// Native menus fade out instead of vanishing. React removes a closed menu at
// once, so as it unmounts a lifeless copy is left in its place and faded out.
// The menu's own logic never waits on the animation.
export function useFadeOutOnUnmount(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const host = ref.current;
    // A `display: contents` wrapper has no box of its own; fade what it wraps.
    const element = host && getComputedStyle(host).display === "contents"
      ? host.firstElementChild as HTMLElement | null
      : host;
    return () => {
      // Layout cleanups run before React detaches the element, so it can still be copied.
      if (!element?.isConnected || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const ghost = fadingCopy(element);
      if (!ghost) return;
      // StrictMode's rehearsal unmount leaves the element in place; only a real close fades.
      queueMicrotask(() => {
        if (element.isConnected) return;
        document.body.append(ghost);
        ghost.getBoundingClientRect();
        ghost.style.opacity = "0";
        setTimeout(() => ghost.remove(), FADE_MS + 50);
      });
    };
  }, [ref]);
}

function fadingCopy(element: HTMLElement): HTMLElement | null {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const computed = getComputedStyle(element);
  // Keeps its id: the menus are styled by id, and the original is already gone
  // by the time the copy is added.
  const ghost = element.cloneNode(true) as HTMLElement;
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  // Pinned where it was on screen, with the inherited text styles it had there.
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    right: "auto",
    bottom: "auto",
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    transform: "none",
    translate: "none",
    visibility: "visible",
    pointerEvents: "none",
    zIndex: "1000",
    color: computed.color,
    fontFamily: computed.fontFamily,
    fontSize: computed.fontSize,
    lineHeight: computed.lineHeight,
    opacity: "1",
    // The copy only fades; it must not replay the menu's opening.
    animation: "none",
    transition: `opacity ${FADE_MS}ms ease`,
  });
  return ghost;
}

/** Fades out whatever it wraps when that part of the tree closes. */
export function FadeOutOnClose({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFadeOutOnUnmount(ref);
  return createElement("div", { ref, style: { display: "contents" } }, children);
}
