import { configuredSearchProviders, loadArtistDetails, searchServerCatalog, type CatalogArtist } from "../api/server";
import { searchText } from "./catalogRanking";

export function matchingArtistImage(name: string, artists: CatalogArtist[]): string | null {
  const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const exact = new Map<string, CatalogArtist>();
  for (const artist of artists) {
    if (normalize(artist.name) !== normalize(name)) continue;
    const existing = exact.get(artist.id);
    if (!existing || (!existing.imageUrl && artist.imageUrl)) exact.set(artist.id, artist);
  }
  return exact.size === 1 ? [...exact.values()][0].imageUrl : null;
}

const cache = new Map<string, { until: number; request: Promise<string | null> }>();
let providers: ReturnType<typeof configuredSearchProviders> | undefined;
let active = 0;
const waiting: Array<() => void> = [];
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 4) await new Promise<void>(resolve => waiting.push(resolve));
  active++;
  try { return await work(); }
  finally { active--; waiting.shift()?.(); }
}

async function lookup(name: string): Promise<string | null> {
  providers ??= configuredSearchProviders(AbortSignal.timeout(8000)).catch(error => { providers = undefined; throw error; });
  for (const service of await providers) {
    try {
      const page = await searchServerCatalog(name, service, AbortSignal.timeout(8000));
      const image = matchingArtistImage(name, page.artists ?? []);
      if (image) return image;
    } catch { /* Try another configured streaming service. */ }
  }
  return null;
}

export function artistImage(name: string, useLimiter = true): Promise<string | null> {
  const key = searchText(name);
  const found = cache.get(key);
  if (found && found.until > Date.now()) return found.request;
  const request = (useLimiter ? limited(() => lookup(name)) : lookup(name)).catch(() => null);
  const entry = { until: Infinity, request };
  cache.set(key, entry);
  void request.then(image => { entry.until = Date.now() + (image ? 3600000 : 30000); });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return request;
}

const storageKey = "ambra.artist-portraits.v1";
type Portrait = { image: string; until: number };
const portraits = new Map<string, Portrait>();
const portraitRequests = new Map<string, Promise<string | null>>();
const misses = new Map<string, number>();
const listeners = new Set<() => void>();
let restored = false;
const portraitKey = (artist: CatalogArtist) => `${artist.provider}:${artist.id.startsWith(`${artist.provider}:`) ? artist.id.slice(artist.provider.length + 1) : artist.id}`;

function restorePortraits() {
  if (restored || typeof localStorage === "undefined") return;
  restored = true;
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(entries)) return;
    for (const entry of entries.slice(-500)) {
      if (!Array.isArray(entry)) continue;
      const [key, value] = entry;
      if (typeof key === "string" && value && typeof value.image === "string" && typeof value.until === "number") portraits.set(key, value);
    }
  } catch { /* A disposable cache must not block rendering. */ }
}

export function cachedArtistImage(artist: CatalogArtist): string | null {
  restorePortraits();
  return portraits.get(portraitKey(artist))?.image ?? null;
}

export function subscribeArtistImages(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function rememberArtistImage(artist: CatalogArtist) {
  if (!artist.imageUrl) return;
  restorePortraits();
  const key = portraitKey(artist);
  const current = portraits.get(key);
  if (current?.image === artist.imageUrl && current.until > Date.now()) return;
  portraits.delete(key);
  portraits.set(key, { image: artist.imageUrl, until: Date.now() + 7 * 24 * 3600_000 });
  while (portraits.size > 500) portraits.delete(portraits.keys().next().value!);
  try { localStorage.setItem(storageKey, JSON.stringify([...portraits])); } catch { /* Memory cache still works. */ }
  for (const listener of listeners) listener();
}

export function resolveArtistImage(artist: CatalogArtist, priority = false): Promise<string | null> {
  restorePortraits();
  const key = portraitKey(artist);
  const cached = portraits.get(key);
  if (cached && cached.until > Date.now()) return Promise.resolve(cached.image);
  const pending = portraitRequests.get(key);
  if (pending && !priority) return pending;
  if ((misses.get(key) ?? 0) > Date.now()) return Promise.resolve(cached?.image ?? null);
  // Name searches already use the limiter; avoid nesting it for local artists.
  const work = async () => {
    // A header can promote a queued card lookup. Its original task then reuses
    // the result instead of fetching again when a background slot opens.
    const current = portraits.get(key);
    if (current && current.until > Date.now()) return current.image;
    if (artist.provider !== "local") {
      const details = await loadArtistDetails(artist);
      // Some services have no photo for smaller artists. Borrow one from another
      // service only when exactly one artist there has this exact name. This
      // already runs in a limiter slot, so the name search must not take another.
      const imageUrl = details.imageUrl ?? await artistImage(details.name, false);
      rememberArtistImage({ ...details, imageUrl });
      return imageUrl;
    }
    const imageUrl = await artistImage(artist.name);
    rememberArtistImage({ ...artist, imageUrl });
    return imageUrl;
  };
  const request = (priority || artist.provider === "local" ? work() : limited(work))
    .catch(() => cached?.image ?? null).then(image => {
      if (!image) {
        misses.set(key, Date.now() + 30_000);
        while (misses.size > 500) misses.delete(misses.keys().next().value!);
      }
      return image;
    }).finally(() => {
      if (portraitRequests.get(key) === request) portraitRequests.delete(key);
    });
  portraitRequests.set(key, request);
  return request;
}
