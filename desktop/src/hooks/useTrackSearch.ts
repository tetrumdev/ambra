import { useCallback, useEffect, useState } from "react";
import {
  resolveTrackPlayback,
  searchServerTracks,
  type SearchProvider,
} from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";

type TrackSearch = {
  results: Track[];
  knownTracks: Track[];
  isSearching: boolean;
  error: string | null;
  resolveTrack: (trackId: GlobalTrackId) => Promise<Track | undefined>;
};

const searchResultsCache = new Map<string, Track[]>();
const searchRequests = new Map<string, Promise<Track[]>>();
const resolvedTracks = new Map<GlobalTrackId, Track>();
const playbackRequests = new Map<GlobalTrackId, Promise<Track>>();
const MAX_CACHED_SEARCHES = 100;
const PREWARMED_TIDAL_RESULTS = 25;

function cacheSearchResults(cacheKey: string, tracks: Track[]) {
  if (
    !searchResultsCache.has(cacheKey) &&
    searchResultsCache.size >= MAX_CACHED_SEARCHES
  ) {
    const oldestKey = searchResultsCache.keys().next().value;
    if (oldestKey !== undefined) searchResultsCache.delete(oldestKey);
  }
  searchResultsCache.set(cacheKey, tracks);
}

function mergeTrack(tracks: Track[], replacement: Track) {
  return tracks.map((track) =>
    track.globalId === replacement.globalId ? replacement : track,
  );
}

function rememberResolvedTrack(track: Track) {
  resolvedTracks.set(track.globalId, track);
  for (const [cacheKey, tracks] of searchResultsCache) {
    if (tracks.some((candidate) => candidate.globalId === track.globalId)) {
      searchResultsCache.set(cacheKey, mergeTrack(tracks, track));
    }
  }
}

function resolvePlayback(track: Track) {
  const resolved = resolvedTracks.get(track.globalId);
  if (resolved) return Promise.resolve(resolved);
  const pending = playbackRequests.get(track.globalId);
  if (pending) return pending;

  const request = resolveTrackPlayback(track)
    .then((resolvedTrack) => {
      rememberResolvedTrack(resolvedTrack);
      return resolvedTrack;
    })
    .catch((reason: unknown) => {
      playbackRequests.delete(track.globalId);
      throw reason;
    });
  playbackRequests.set(track.globalId, request);
  return request;
}

function searchText(track: Track) {
  return `${track.name} ${track.artist} ${track.album}`.toLocaleLowerCase();
}

function cachedPreview(provider: SearchProvider, query: string) {
  const normalizedQuery = query.toLocaleLowerCase();
  const providerPrefix = `${provider}:`;
  let closestQuery = "";
  let closestResults: Track[] = [];

  for (const [cacheKey, tracks] of searchResultsCache) {
    if (!cacheKey.startsWith(providerPrefix)) continue;
    const cachedQuery = cacheKey.slice(providerPrefix.length);
    if (
      normalizedQuery.startsWith(cachedQuery) &&
      cachedQuery.length > closestQuery.length
    ) {
      closestQuery = cachedQuery;
      closestResults = tracks;
    }
  }

  return closestResults.filter((track) =>
    searchText(track).includes(normalizedQuery),
  );
}

function requestSearch(
  query: string,
  provider: SearchProvider,
  signal: AbortSignal,
) {
  const cacheKey = `${provider}:${query.toLocaleLowerCase()}`;
  const pending = searchRequests.get(cacheKey);
  if (pending) return pending;

  const request = searchServerTracks(query, provider, signal)
    .then((tracks) => {
      const resolved = tracks.map(
        (track) => resolvedTracks.get(track.globalId) ?? track,
      );
      cacheSearchResults(cacheKey, resolved);
      return resolved;
    })
    .finally(() => searchRequests.delete(cacheKey));
  searchRequests.set(cacheKey, request);
  return request;
}

export function useTrackSearch(
  query: string,
  provider: SearchProvider,
): TrackSearch {
  const [results, setResults] = useState<Track[]>([]);
  const [knownTracks, setKnownTracks] = useState<Track[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyResolvedTrack = useCallback((track: Track) => {
    setResults((current) => mergeTrack(current, track));
    setKnownTracks((current) => {
      const existing = current.some(
        (candidate) => candidate.globalId === track.globalId,
      );
      return existing ? mergeTrack(current, track) : [...current, track];
    });
  }, []);

  const resolveTrack = useCallback(
    async (trackId: GlobalTrackId) => {
      const track =
        results.find((candidate) => candidate.globalId === trackId) ??
        knownTracks.find((candidate) => candidate.globalId === trackId);
      if (!track) return undefined;
      try {
        const resolved = await resolvePlayback(track);
        applyResolvedTrack(resolved);
        return resolved;
      } catch (reason) {
        console.warn("Could not prewarm Tidal playback metadata:", reason);
        return track;
      }
    },
    [applyResolvedTrack, knownTracks, results],
  );

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setResults([]);
      setIsSearching(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const prewarm = async (tracks: Track[]) => {
      const tidalTracks = tracks
        .filter((track) => track.provider === "tidal")
        .slice(0, PREWARMED_TIDAL_RESULTS);
      for (let index = 0; index < tidalTracks.length; index += 2) {
        if (cancelled) break;
        const batch = tidalTracks.slice(index, index + 2);
        await Promise.allSettled(
          batch.map(async (track) => {
            const resolved = await resolvePlayback(track);
            if (!cancelled) applyResolvedTrack(resolved);
          }),
        );
      }
    };

    const cacheKey = `${provider}:${trimmedQuery.toLocaleLowerCase()}`;
    const cachedResults = searchResultsCache.get(cacheKey);
    if (cachedResults) {
      setResults(cachedResults);
      setKnownTracks((current) => {
        const tracksById = new Map(
          current.map((track) => [track.globalId, track]),
        );
        for (const track of cachedResults) {
          tracksById.set(track.globalId, track);
        }
        return [...tracksById.values()];
      });
      setIsSearching(false);
      setError(null);
      void prewarm(cachedResults);
      return () => {
        cancelled = true;
      };
    }

    const controller = new AbortController();
    setResults((current) => {
      const matchingCurrent = current.filter((track) =>
        searchText(track).includes(trimmedQuery.toLocaleLowerCase()),
      );
      return matchingCurrent.length > 0
        ? matchingCurrent
        : cachedPreview(provider, trimmedQuery);
    });
    setIsSearching(true);
    setError(null);

    const timer = window.setTimeout(() => {
      void requestSearch(trimmedQuery, provider, controller.signal)
        .then((tracks) => {
          if (cancelled) return;
          setResults(tracks);
          setKnownTracks((current) => {
            const tracksById = new Map(
              current.map((track) => [track.globalId, track]),
            );
            for (const track of tracks) tracksById.set(track.globalId, track);
            return [...tracksById.values()];
          });

          void prewarm(tracks);
        })
        .catch((reason: unknown) => {
          if (!cancelled && !controller.signal.aborted) setError(String(reason));
        })
        .finally(() => {
          if (!cancelled) setIsSearching(false);
        });
    }, 100);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [applyResolvedTrack, provider, query]);

  return { results, knownTracks, isSearching, error, resolveTrack };
}
