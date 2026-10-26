import { useSyncExternalStore } from "react";

/**
 * Ambra's own "Reduce motion" setting (Settings → Player), which makes transitions instant.
 * Deliberately not the system's prefers-reduced-motion: people turn system animations off to
 * make their machine feel snappier, not to stop the player moving. Stylesheets read it as
 * `:root[data-reduce-motion]`.
 */
let reduced = false;
const listeners = new Set<() => void>();

export const reducedMotion = () => reduced;

export function setReducedMotion(value: boolean) {
  if (value === reduced) return;
  reduced = value;
  document.documentElement.toggleAttribute("data-reduce-motion", value);
  for (const listener of listeners) listener();
}

export function subscribeReducedMotion(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotion);
}
