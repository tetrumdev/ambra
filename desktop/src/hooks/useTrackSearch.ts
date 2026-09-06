import { useCallback, useEffect, useRef, useState } from "react";
import { configuredSearchProviders, resolveTrackPlayback, searchServerCatalog, type SearchProvider } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { groupSearchResults } from "../utils/searchRanking";
import { SearchSession, type SearchSnapshot } from "../utils/searchSession";

const empty: SearchSnapshot = { results: [], candidates: [], artists: [], albums: [], isSearching: false, hasMore: false, error: null, canRetry: false };
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

  useEffect(() => {
    const trimmedQuery = query.trim();
    const controller = new AbortController();
    let session: SearchSession | null = null;
    sessionRef.current = null;
    setSnapshot(trimmedQuery ? { ...empty, isSearching: true } : empty);
    if (!trimmedQuery) return;

    // Enrich a bounded set of leading recording groups, including hidden TIDAL alternatives.
    const warmed = new Set<string>();
    const queue: Track[] = [];
    let active = 0;
    const drain = () => {
      while (active < 2 && queue.length && !controller.signal.aborted) {
        const track = queue.shift()!;
        active++;
        void resolvePlayback(track, controller.signal).then(resolved => {
          if (!controller.signal.aborted) session?.replaceTrack(resolved);
        }).catch(() => {}).finally(() => { active--; drain(); });
      }
    };
    const onUpdate = (next: SearchSnapshot) => {
      if (controller.signal.aborted) return;
      setSnapshot(next);
      remember(next.candidates);
      if (!next.isSearching && warmed.size < 5) {
        const leaders = new Set(next.results.slice(0, 5).map(track => track.globalId));
        const alternatives = groupSearchResults(next.candidates, trimmedQuery)
          .filter(group => leaders.has(group.track.globalId)).flatMap(group => group.alternatives);
        for (const track of alternatives) {
          if (warmed.size >= 5) break;
          if (track.provider !== "tidal" || warmed.has(track.globalId)) continue;
          warmed.add(track.globalId);
          queue.push(track);
        }
        drain();
      }
    };
    const timer = window.setTimeout(() => {
      const discoveryTimeout = window.setTimeout(() => controller.abort(), 8000);
      void configuredSearchProviders(controller.signal).then(providers => {
        window.clearTimeout(discoveryTimeout);
        if (controller.signal.aborted) return;
        const selected = provider === "all" ? providers : providers.filter(value => value === provider);
        session = new SearchSession({
          query: trimmedQuery, providers: selected, combined: provider === "all", onUpdate,
          fetchPage: async (...args) => {
            const page = await searchServerCatalog(args[0], args[1], args[2]);
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
  }, [query, provider, attempt, remember]);

  const loadMore = useCallback(() => { void sessionRef.current?.loadMore(); }, []);
  const retry = useCallback(() => {
    if (sessionRef.current) void sessionRef.current.retry();
    else setAttempt(value => value + 1);
  }, []);

  return { ...snapshot, knownTracks, resolveTrack, loadMore, retry };
}
