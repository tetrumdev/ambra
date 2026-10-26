import { useEffect, useRef, useState } from "react";
import { loadDiscover, type DiscoverResponse, type DiscoverStatus } from "../api/server";
import { serverBaseUrl } from "../api/serverConnection";
import { useServiceAvailability } from "./useServiceAvailability";
import type { ListeningEntry } from "./useListeningHistory";
import { serverStateStatus, subscribeServerState } from "../utils/serverState";

const refreshMs = 60_000;
const debounceMs = 2000;

export function discoverMessage(status: DiscoverStatus | "error") {
  switch (status) {
    case "loading": return "Finding music for you…";
    case "insufficientHistory": return "Listen to some music to discover new favorites.";
    case "noProviders": return "Connect a music service or import music to discover new favorites.";
    case "noMatches": return "No new matches yet. Keep listening to explore more music.";
    case "databaseUnavailable": return "Discovery metadata is temporarily unavailable. Try again later.";
    case "stateUnavailable": return "Listening history is temporarily unavailable. Try again later.";
    case "providerUnavailable": return "Music services are temporarily unavailable. Try again later.";
    case "error": return "Discover could not reach your server. It will retry when connected.";
    default: return "Listen to some music to discover new favorites.";
  }
}

/** Debounced history updates; cancellation and sequence guard reject stale responses.
 * Server-side jobs survive navigation. Every connected client receives the same ranking.
 */
export function useDiscover(entries: ListeningEntry[]) {
  const connected = useServiceAvailability();
  const [data, setData] = useState<DiscoverResponse | null>(null);
  const [error, setError] = useState(false);
  const refresh = useRef<((delay?: number) => void) | null>(null);
  const history = useRef(entries);

  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    let lastRequest = 0;
    const server = serverBaseUrl;
    const schedule = (delay = refreshMs) => {
      clearTimeout(timer);
      timer = setTimeout(() => { void fetchRecommendations(); }, delay);
    };
    const fetchRecommendations = async () => {
      controller?.abort();
      controller = new AbortController();
      const current = ++sequence;
      lastRequest = Date.now();
      try {
        const value = await loadDiscover(controller.signal);
        if (disposed || current !== sequence || server !== serverBaseUrl) return;
        setData(value);
        setError(false);
        schedule(value.status === "loading" ? Math.max(1000, value.refreshAfterMs ?? 2000) : refreshMs);
      } catch {
        if (disposed || current !== sequence || controller.signal.aborted) return;
        setError(true);
        schedule(refreshMs);
      }
    };
    // Meaningful changes coalesce; no more than one normal refresh per minute.
    refresh.current = (delay = debounceMs) => schedule(Math.max(delay, refreshMs - (Date.now() - lastRequest)));
    const reconnect = () => schedule(debounceMs);
    let wasReady = serverStateStatus().ready && !serverStateStatus().error;
    const unsubscribe = subscribeServerState(() => {
      const state = serverStateStatus();
      const ready = state.ready && !state.error;
      if (ready && !wasReady) reconnect();
      wasReady = ready;
    });
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    void fetchRecommendations();
    return () => {
      disposed = true;
      sequence++;
      clearTimeout(timer);
      controller?.abort();
      refresh.current = null;
      unsubscribe();
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
    };
  }, [connected]);

  useEffect(() => {
    if (history.current === entries) return;
    history.current = entries;
    refresh.current?.();
  }, [entries]);

  return { tracks: data?.tracks ?? [], message: discoverMessage(error ? "error" : data?.status ?? "loading"),
    loading: !error && (!data || data.status === "loading") };
}
