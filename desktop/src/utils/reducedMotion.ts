import { useSyncExternalStore } from "react";

/**
 * Desktop uses the Reduce motion setting in Settings → Player. The browser remote
 * uses the system preference. Stylesheets read `:root[data-reduce-motion]`.
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
