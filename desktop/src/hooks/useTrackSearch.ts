import { useCallback, useEffect, useRef, useState } from "react";
import { configuredSearchProviders, loadAlbumTracks, resolveTrackPlayback, searchServerCatalog, type SearchProvider } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { leaderWarmup } from "../utils/searchWarmup";
import { SearchSession, type SearchSnapshot } from "../utils/searchSession";
import { preloadArtwork } from "../utils/artworkImages";
import { providerThumbnail } from "../utils/providerThumbnail";

const empty: SearchSnapshot = { results: [], allResults: [], candidates: [], artists: [], albums: [], order: ["tracks", "artists", "albums"], isSearching: false, hasMore: false, error: null, canRetry: false };
const resolvedTracks = new Map<string, { track: Track; expires: number }>();

function cachedTrack(track: Track) {
  const cached = resolvedTracks.get(track.globalId);
  if (cached && cached.expires > Date.now()) return cached.track;
  resolvedTracks.delete(track.globalId);
  return track;
}

async function resolvePlayback(track: Track, signal?: AbortSignal) {
  const cached = cachedTrack(track);
  if (cached !== track) return cached;
  const resolved = await resolveTrackPlayback(track, signal);
  if (signal?.aborted) return track;
  resolvedTracks.delete(track.globalId);
  resolvedTracks.set(track.globalId, { track: resolved, expires: Date.now() + 5 * 60_000 });
  if (resolvedTracks.size > 100) resolvedTracks.delete(resolvedTracks.keys().next().value!);
  return resolved;
}

/**
 * One search, from the query changing to its last update: the debounce, service discovery, the
 * session and the warming of leading songs. Returns its cleanup. Kept apart from the hook so the
 * search benchmark (bench/) runs exactly what the app runs.
 */
export function startTrackSearch(query: string, provider: SearchProvider, sessionRef: { current: SearchSession | null },
  setSnapshot: (snapshot: SearchSnapshot) => void, remember: (tracks: Track[]) => void): () => void {
  const trimmedQuery = query.trim();
  const controller = new AbortController();
  let session: SearchSession | null = null;
  sessionRef.current = null;
  setSnapshot(trimmedQuery ? { ...empty, isSearching: true } : empty);
  if (!trimmedQuery) return () => {};

  const warm = leaderWarmup(trimmedQuery, controller.signal, resolvePlayback, track => session?.replaceTrack(track));
  const onUpdate = (next: SearchSnapshot) => {
    if (controller.signal.aborted) return;
    setSnapshot(next);
    remember(next.candidates);
    warm(next);
  };
  // Asked during the debounce rather than after it; usually answered from the last minute's list.
  const discovery = configuredSearchProviders(controller.signal);
  discovery.catch(() => {});
  const timer = window.setTimeout(() => {
    const discoveryTimeout = window.setTimeout(() => controller.abort(), 8000);
    void discovery.then(providers => {
      window.clearTimeout(discoveryTimeout);
      if (controller.signal.aborted) return;
      const selected = provider === "all" ? providers : providers.filter(value => value === provider);
      session = new SearchSession({
        query: trimmedQuery, providers: selected, combined: provider === "all", onUpdate,
        albumTracks: async (album, signal) => (await loadAlbumTracks(album, signal)).map(cachedTrack),
        fetchPage: async (...args) => {
          const page = await searchServerCatalog(args[0], args[1], args[2]);
          // Use the brief result-merging window to fetch covers before their cards mount.
          if (!args[2].aborted) page.tracks.slice(0, 5).forEach((track, index) => {
            void preloadArtwork(providerThumbnail(track.nativeCover ?? track.cover), false, {
              fetchPriority: index === 0 ? "high" : "auto", timeoutMs: 3000,
            }).catch(() => {});
          });
          return { ...page, tracks: page.tracks.map(cachedTrack) };
        },
      });
      sessionRef.current = session;
      return session.loadMore();
    }).catch(error => {
      // A cleanup abort must not publish into a newer query.
      if (sessionRef.current === session && !disposed) {
        setSnapshot({ ...empty, error: controller.signal.aborted ? "Loading music services timed out." : String(error), canRetry: true });
      }
    }).finally(() => window.clearTimeout(discoveryTimeout));
  }, 150);
  let disposed = false;
  return () => {
    disposed = true;
    window.clearTimeout(timer);
    controller.abort();
    session?.cancel();
    if (sessionRef.current === session) sessionRef.current = null;
  };
}

export function useTrackSearch(query: string, provider: SearchProvider) {
  const [snapshot, setSnapshot] = useState<SearchSnapshot>(empty);
  const [knownTracks, setKnownTracks] = useState<Track[]>([]);
  const sessionRef = useRef<SearchSession | null>(null);
  const [attempt, setAttempt] = useState(0);

  const remember = useCallback((tracks: Track[]) => {
    setKnownTracks(current => {
      const byId = new Map(current.map(track => [track.globalId, track]));
      for (const track of tracks) byId.set(track.globalId, track);
      return [...byId.values()];
    });
  }, []);

  const resolveTrack = useCallback(async (trackId: GlobalTrackId) => {
    const track = snapshot.candidates.find(track => track.globalId === trackId) ?? knownTracks.find(track => track.globalId === trackId);
    if (!track) return undefined;
    try {
      const resolved = await resolvePlayback(track);
      sessionRef.current?.replaceTrack(resolved);
      remember([resolved]);
      return resolved;
    } catch (error) {
      console.warn("Could not resolve playback metadata:", error);
      return track;
    }
  }, [knownTracks, remember, snapshot.candidates]);

  // `attempt` restarts the search after a failed service discovery.
  useEffect(() => startTrackSearch(query, provider, sessionRef, setSnapshot, remember), [query, provider, attempt, remember]);

  const loadMore = useCallback(() => { void sessionRef.current?.loadMore(); }, []);
  const retry = useCallback(() => {
    if (sessionRef.current) void sessionRef.current.retry();
    else setAttempt(value => value + 1);
  }, []);

  return { ...snapshot, knownTracks, resolveTrack, loadMore, retry };
}
