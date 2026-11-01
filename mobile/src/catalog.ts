import type { RemoteTrack, SearchPage, ServiceAuthStatus } from "../../desktop/src/api/server";
import { remoteTrack } from "../../desktop/src/utils/remoteTrack";
import { SearchSession, type SearchSnapshot } from "../../desktop/src/utils/searchSession";
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
