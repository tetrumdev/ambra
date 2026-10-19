import { configuredSearchProviders, loadArtistAlbums, loadArtistProfile, searchServerCatalog, type CatalogAlbum, type CatalogArtist } from "../api/server";
import { rememberArtistImage } from "./artistImages";
import { albumIdentity, bestEditions, searchText } from "./catalogRanking";

export function prefetchArtistPage(artist: CatalogArtist) {
  if (artist.provider === "local") return;
  void loadArtistProfile(artist).then(profile => rememberArtistImage(profile.artist)).catch(() => {});
  void loadArtistAlbums(artist).catch(() => {});
}

export function artistReleaseSections(albums: CatalogAlbum[]) {
  const sections = ["Albums", "EPs & singles", "Live", "Other releases"].map(title => ({ title, albums: [] as CatalogAlbum[] }));
  for (const album of new Map(albums.map(album => [album.id, album])).values()) {
    const type = album.releaseType?.toLowerCase().replace(/[\s_-]/g, "") ?? "album";
    const index = ["ep", "single", "epsingle", "epsandsingles"].includes(type) ? 1 : type === "live" ? 2 : type === "album" ? 0 : 3;
    sections[index].albums.push(album);
  }
  for (const section of sections) section.albums.sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.title.localeCompare(b.title));
  return sections.filter(section => section.albums.length);
}
export function artistBiography(value: string | null | undefined): string[] {
  if (!value) return [];
  const paragraphs = value.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "").replace(/<\/?(?:p|div|br|li)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, "");
  const decoded = paragraphs.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[entity] ?? entity);
  return decoded.split(/\n+/).map(paragraph => paragraph.trim()).filter(Boolean);
}

const counterparts = new Map<string, Promise<CatalogArtist[]>>();

/**
 * The same artist on every connected service. Search already gathers the services it
 * found; elsewhere the others are looked up by name, and a service counts only when
 * exactly one of its artists has that exact name.
 */
export function artistSources(artist: CatalogArtist): Promise<CatalogArtist[]> {
  const known = artist.sources ?? [artist];
  if (artist.provider === "local") return Promise.resolve(known);
  const key = known.map(source => source.id).sort().join("|");
  const cached = counterparts.get(key);
  if (cached) return cached;
  const request = configuredSearchProviders(AbortSignal.timeout(8000)).then(async (providers): Promise<CatalogArtist[]> => {
    const found = await Promise.all(providers.filter(provider => !known.some(source => source.provider === provider)).map(async (provider): Promise<CatalogArtist | null> => {
      try {
        const page = await searchServerCatalog(artist.name, provider, AbortSignal.timeout(8000));
        const matches = new Map((page.artists ?? []).filter(candidate => searchText(candidate.name) === searchText(artist.name)).map(candidate => [candidate.id, candidate]));
        return matches.size === 1 ? { ...[...matches.values()][0], sources: undefined } : null;
      } catch {
        return null;
      }
    }));
    return [...known, ...found.filter((source): source is CatalogArtist => source !== null)];
  }).catch(() => {
    counterparts.delete(key);
    return known;
  });
  counterparts.set(key, request);
  if (counterparts.size > 200) counterparts.delete(counterparts.keys().next().value!);
  return request;
}

/**
 * Releases from every service as one discography, each album in its best available copy.
 * A same-named artist elsewhere only contributes once it shares an album with this one,
 * so a namesake's records never leak in.
 */
export function mergedArtistReleases(artist: CatalogArtist, sources: CatalogArtist[], releases: Record<string, { albums: CatalogAlbum[] }>): CatalogAlbum[] {
  const own = releases[artist.id];
  if (!own) return [];
  const identities = new Set(own.albums.map(albumIdentity));
  const trusted = sources.filter(source => source.id === artist.id || !identities.size || releases[source.id]?.albums.some(album => identities.has(albumIdentity(album))));
  return bestEditions(trusted.flatMap(source => releases[source.id]?.albums ?? []));
}
