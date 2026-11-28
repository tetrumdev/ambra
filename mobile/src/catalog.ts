import type { RemoteTrack, SearchPage, ServiceAuthStatus } from "../../desktop/src/api/server";
import { remoteTrack } from "../../desktop/src/utils/remoteTrack";
import { SearchSession, type SearchSnapshot } from "../../desktop/src/utils/searchSession";
import { searchText, textRelevance } from "../../desktop/src/utils/catalogRanking";
import { catalogSearch, type CatalogPage } from "./library";
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

export async function openSearch(query: string, selected: EnabledServices, provider: "all" | Service, signal: AbortSignal, onUpdate: (snapshot: SearchSnapshot) => void) {
  const configured = await request<{ providers: Service[] }>("/api/search/providers", { signal, timeoutMs: 10_000 });
  if (signal.aborted) return null;
  const providers = services.filter(service => selected[service] && configured.providers.includes(service) && (provider === "all" || provider === service));
  const session = new SearchSession({ query, providers, combined: provider === "all", fetchPage: searchPage, onUpdate });
  signal.addEventListener("abort", () => session.cancel(), { once: true });
  if (signal.aborted) { session.cancel(); return null; }
  void session.loadMore();
  return session;
}

/** Merges each service's catalog answer, best name matches first and one card per name. */
export function mergeCatalog(query: string, pages: CatalogPage[]) {
  const unique = <T,>(items: T[], key: (item: T) => string) => [...new Map(items.map(item => [key(item), item])).values()];
  const artists = unique(pages.flatMap(page => page.artists), artist => searchText(artist.name))
    .sort((a, b) => textRelevance(b.name, query) - textRelevance(a.name, query)).slice(0, 12);
  const albums = unique(pages.flatMap(page => page.albums), album => `${searchText(album.title)}:${searchText(album.artist)}`)
    .sort((a, b) => textRelevance(b.title, query) - textRelevance(a.title, query)).slice(0, 16);
  return { artists, albums };
}

type SearchCallbacks = {
  tracks: (snapshot: SearchSnapshot) => void;
  session: (session: SearchSession | null) => void;
  error: (reason: unknown) => void;
  catalog: (value: ReturnType<typeof mergeCatalog>) => void;
};

/**
 * The search screen's search for one query: songs through a session, artists and albums from each
 * service's catalog search, each after its own debounce. Nothing is reported once `signal` aborts.
 * Returns a cleanup that cancels the timers. Kept apart from the screen so the search benchmark
 * (bench/) runs exactly what the phone runs.
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
  // Artists and albums, as desktop's catalog search finds them, alongside the songs.
  const catalogTimer = setTimeout(() => {
    if (!trimmed) return;
    const providers = services.filter(service => selected[service] && (provider === "all" || provider === service));
    void Promise.allSettled(providers.map(service => catalogSearch(trimmed, service, signal))).then(results => {
      if (signal.aborted) return;
      const pages = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      report.catalog(mergeCatalog(trimmed, pages));
    });
  }, 350);
  return () => { clearTimeout(timer); clearTimeout(catalogTimer); };
}
