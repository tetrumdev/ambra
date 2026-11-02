import type { MusicProvider } from "../types/music";

/** The service whose copy is shown when several services have a song or album in equal quality. */
export type PreferredService = "off" | Exclude<MusicProvider, "local">;

const KEY = "ambra.preferred-service.v1";
/**
 * Equal copies are settled in this order when no service is preferred, the same way for songs
 * and albums, so a song and its album always come from one service.
 */
const DEFAULT_ORDER: MusicProvider[] = ["local", "qobuz", "tidal", "spotify"];
const listeners = new Set<() => void>();

export function preferredService(): PreferredService {
  try {
    const value = globalThis.localStorage?.getItem(KEY);
    return value === "qobuz" || value === "tidal" || value === "spotify" ? value : "off";
  } catch {
    return "off";
  }
}

export function setPreferredService(service: PreferredService) {
  try {
    if (service === "off") globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, service);
  } catch {
    // Without storage the default order applies.
  }
  for (const listener of listeners) listener();
}

export function subscribePreferredService(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Higher wins between copies of equal quality: the preferred service, then a fixed order. */
export function serviceRank(provider: MusicProvider): number {
  if (provider === preferredService()) return DEFAULT_ORDER.length + 1;
  const index = DEFAULT_ORDER.indexOf(provider);
  return index < 0 ? 0 : DEFAULT_ORDER.length - index;
}
