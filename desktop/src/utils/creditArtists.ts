import { useEffect, useMemo, useState } from "react";
import { searchServerCatalog, type CatalogArtist, type StreamingProvider } from "../api/server";
import type { Track } from "../types/music";
import { searchText } from "./catalogRanking";

const CONCURRENCY = 3;
// Looked up once per session: an artist page found (or not) for a name on a catalog.
const lookups = new Map<string, Promise<CatalogArtist | null>>();

function artistOn(provider: StreamingProvider | Track["provider"], id: string, name: string, imageUrl: string | null = null): CatalogArtist {
  return { id: id.startsWith(`${provider}:`) ? id : `${provider}:${id}`, provider, name, imageUrl };
}

/** An artist page with exactly this name on the catalog, or null when it has none. */
function findArtist(name: string, provider: StreamingProvider): Promise<CatalogArtist | null> {
  const key = `${provider}:${searchText(name)}`;
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = searchServerCatalog(name, provider)
      .then(page => page.artists?.find(artist => searchText(artist.name) === searchText(name)) ?? null)
      .catch(() => {
        // A failed search may succeed next time the credits open.
        lookups.delete(key);
        return null;
      });
    lookups.set(key, lookup);
  }
  return lookup;
}

/**
 * Artist pages for credited names: IDs the catalog gave with the credits, then the
 * recording's own credited artists, then an exact-name search of the catalog the credits
 * came from. Names without a page stay plain text.
 */
export function useCreditArtists(
  names: string[],
  source: StreamingProvider | null,
  catalogIds: Record<string, string>,
  tracks: Track[],
) {
  const known = useMemo(() => {
    const found = new Map<string, CatalogArtist>();
    for (const track of tracks) {
      for (const artist of [...track.artists, ...track.albumArtists]) {
        if (artist.providerId && track.provider !== "local") found.set(searchText(artist.name), artistOn(track.provider, artist.providerId, artist.name, artist.imageUrl));
      }
    }
    if (source) for (const [name, id] of Object.entries(catalogIds)) found.set(searchText(name), artistOn(source, id, name));
    return found;
  }, [tracks, source, catalogIds]);
  const [searched, setSearched] = useState<Map<string, CatalogArtist>>(new Map());
  const key = names.join("\n");

  useEffect(() => {
    setSearched(new Map());
    if (!source) return;
    const pending = [...new Set(names)].filter(name => !known.has(searchText(name)));
    let cancelled = false;
    let next = 0;
    const work = async () => {
      while (!cancelled && next < pending.length) {
        const name = pending[next++];
        const artist = await findArtist(name, source);
        if (artist && !cancelled) setSearched(current => new Map(current).set(searchText(name), artist));
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, work));
    return () => { cancelled = true; };
  }, [key, source, known]);

  return (name: string) => known.get(searchText(name)) ?? searched.get(searchText(name)) ?? null;
}
