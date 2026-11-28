import type { CatalogAlbum, CatalogArtist, RemoteTrack, SearchPage, ServiceAuthStatus } from "../../desktop/src/api/server";
import { remoteTrack } from "../../desktop/src/utils/remoteTrack";
import { SearchSession, type SearchSnapshot } from "../../desktop/src/utils/searchSession";
import { enrichCatalogPage } from "../../desktop/src/utils/catalogSearch";
import { SearchCache } from "../../desktop/src/utils/searchCache";
import { albumTracks } from "./library";
import { phoneMediaUrl, request } from "./client";
import { services, type EnabledServices, type Service } from "./servicePreferences";

export const serviceStatus = (signal: AbortSignal) => request<ServiceAuthStatus>("/api/auth/status", { signal, timeoutMs: 10_000 });
export const serverInfo = (signal: AbortSignal) => request<{ name: string; version?: string }>("/api/server/info", { signal, timeoutMs: 10_000 });

export async function searchPage(query: string, provider: Service, signal: AbortSignal, offset: number, limit: number): Promise<SearchPage> {
  const parameters = new URLSearchParams({ query, provider, offset: String(offset), limit: String(limit) });
  const page = await request<{ tracks: RemoteTrack[]; nextOffset: number | null }>(`/api/search/tracks?${parameters}`, { signal, timeoutMs: 25_000 });
  if (!Array.isArray(page.tracks) || (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset))) {
    throw new Error("The server returned invalid search results. Update Ambra server and try again.");
  }
  return { tracks: page.tracks.map(track => remoteTrack(track, phoneMediaUrl)), nextOffset: page.nextOffset };
}

const CATALOG_PAGE = 20;
const catalogResponses = new SearchCache<SearchPage>();

/**
 * A service's first page as desktop gets it: songs, artists and albums from its catalog search,
 * completed from its own songs (`enrichCatalogPage`). Later pages are songs only (`searchPage`).
 */
export async function catalogPage(query: string, provider: Service, signal: AbortSignal): Promise<SearchPage> {
  let found = 0;
  const fetchCatalog = async (value: string, requestSignal: AbortSignal = signal): Promise<SearchPage> => {
    const parameters = new URLSearchParams({ query: value, provider, limit: String(CATALOG_PAGE) });
    const key = parameters.toString();
    let page = catalogResponses.get(key);
    if (!page) {
      const answer = await request<{ tracks: RemoteTrack[]; artists?: CatalogArtist[]; albums?: CatalogAlbum[] }>(`/api/search/catalog?${parameters}`, { signal: requestSignal, timeoutMs: 25_000 });
      page = { tracks: answer.tracks.map(track => remoteTrack(track, phoneMediaUrl)), artists: answer.artists ?? [], albums: answer.albums ?? [], nextOffset: null };
      catalogResponses.set(key, page);
    }
    if (value === query) found = page.tracks.length;
    return page;
  };
  const page = await enrichCatalogPage(query, provider, signal, fetchCatalog);
  // A full first page may have more songs after it, paged through the song search.
  return { ...page, nextOffset: found >= CATALOG_PAGE ? CATALOG_PAGE : null };
}


const firstPageFromCatalog = (query: string, provider: Service, signal: AbortSignal, offset: number, limit: number) =>
  offset === 0 ? catalogPage(query, provider, signal) : searchPage(query, provider, signal, offset, limit);

export async function openSearch(query: string, selected: EnabledServices, provider: "all" | Service, signal: AbortSignal, onUpdate: (snapshot: SearchSnapshot) => void) {
  const configured = await request<{ providers: Service[] }>("/api/search/providers", { signal, timeoutMs: 10_000 });
  if (signal.aborted) return null;
  const providers = services.filter(service => selected[service] && configured.providers.includes(service) && (provider === "all" || provider === service));
  const session = new SearchSession({ query, providers, combined: provider === "all", fetchPage: firstPageFromCatalog, onUpdate, albumTracks });
  signal.addEventListener("abort", () => session.cancel(), { once: true });
  if (signal.aborted) { session.cancel(); return null; }
  void session.loadMore();
  return session;
}


type SearchCallbacks = {
  tracks: (snapshot: SearchSnapshot) => void;
  session: (session: SearchSession | null) => void;
  error: (reason: unknown) => void;
};

/**
 * The search screen's search for one query, after a short debounce: songs, artists and albums
 * from one session, ranked and ordered as on desktop. Nothing is reported once `signal` aborts.
 * Returns a cleanup that cancels the debounce. Kept apart from the screen so the search
 * benchmark (bench/) runs exactly what the phone runs.
 */
export function startSearch(trimmed: string, selected: EnabledServices, provider: "all" | Service, signal: AbortSignal, report: SearchCallbacks) {
  const timer = setTimeout(() => {
    if (!trimmed) return;
    void openSearch(trimmed, selected, provider, signal, next => {
      if (!signal.aborted) report.tracks(next);
    }).then(next => { if (!signal.aborted) report.session(next); }).catch(reason => {
      if (!signal.aborted) report.error(reason);
    });
  }, 300);
  return () => clearTimeout(timer);
}
