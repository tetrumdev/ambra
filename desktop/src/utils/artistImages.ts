import { configuredSearchProviders, searchServerCatalog, type CatalogArtist } from "../api/server";
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
  if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
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

export function artistImage(name: string): Promise<string | null> {
  const key = searchText(name);
  const found = cache.get(key);
  if (found && found.until > Date.now()) return found.request;
  const request = limited(() => lookup(name)).catch(() => null);
  const entry = { until: Infinity, request };
  cache.set(key, entry);
  void request.then(image => { entry.until = Date.now() + (image ? 3600000 : 30000); });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return request;
}
