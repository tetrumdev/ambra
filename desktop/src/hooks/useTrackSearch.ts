import { useEffect, useState } from "react";
import {
  searchServerTracks,
  type SearchProvider,
} from "../api/server";
import type { Track } from "../types/music";

type TrackSearch = {
  results: Track[];
  knownTracks: Track[];
  isSearching: boolean;
  error: string | null;
};

export function useTrackSearch(
  query: string,
  provider: SearchProvider,
): TrackSearch {
  const [results, setResults] = useState<Track[]>([]);
  const [knownTracks, setKnownTracks] = useState<Track[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setResults([]);
      setIsSearching(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setResults([]);
    setIsSearching(true);
    setError(null);

    const timer = window.setTimeout(() => {
      void searchServerTracks(trimmedQuery, provider, controller.signal)
        .then((tracks) => {
          setResults(tracks);
          setKnownTracks((current) => {
            const tracksById = new Map(
              current.map((track) => [track.globalId, track]),
            );
            for (const track of tracks) tracksById.set(track.globalId, track);
            return [...tracksById.values()];
          });
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(String(reason));
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsSearching(false);
        });
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [provider, query]);

  return { results, knownTracks, isSearching, error };
}
