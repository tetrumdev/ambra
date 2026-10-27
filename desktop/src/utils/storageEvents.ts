const listeners = new Set<(key: string) => void>();
export function subscribeLocalStorage(listener: (key: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyLocalStorage(key: string) { for (const listener of listeners) listener(key); }
