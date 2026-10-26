import { useEffect, useState } from "react";
import { needsLyricsRetry, type TrackLyrics } from "../../desktop/src/utils/lyricsWire";
import { serverAddress, trackLyrics, type Track } from "./client";
import { lyricsKey } from "./lyricsModel";

const cache = new Map<string, { lyrics: TrackLyrics; expires: number }>();
type Result = { key: string; attempt: number; lyrics?: TrackLyrics; error?: string };

function cachedLyrics(key: string) {
  const entry = cache.get(key);
  return entry && entry.expires > Date.now() ? entry.lyrics : undefined;
}

export function useLyrics(track: Track | null, active: boolean) {
  const key = track ? `${serverAddress()}:${lyricsKey(track)}` : "";
  const [result, setResult] = useState<Result>({ key: "", attempt: 0 });
  const [retry, setRetry] = useState({ key: "", attempt: 0 });
  const attempt = retry.key === key ? retry.attempt : 0;
  useEffect(() => {
    if (!track || !active) return;
    const abort = new AbortController();
    if (cachedLyrics(key)) return;
    void trackLyrics(track, abort.signal).then(lyrics => {
      if (abort.signal.aborted) return;
      if (!needsLyricsRetry(lyrics)) {
        cache.delete(key);
        cache.set(key, { lyrics, expires: Date.now() + 30 * 60_000 });
        if (cache.size > 12) cache.delete(cache.keys().next().value!);
      }
      setResult({ key, attempt, lyrics });
    }).catch(error => {
      if (!abort.signal.aborted) setResult({ key, attempt, error: error instanceof Error ? error.message : "Couldn't load lyrics." });
    });
    return () => abort.abort();
    // The key includes every piece of lookup metadata; position reports do not restart a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, attempt]);
  const cached = cachedLyrics(key);
  const current = result.key === key && result.attempt === attempt ? result : undefined;
  return { key, lyrics: cached ?? current?.lyrics, error: current?.error, loading: active && !cached && !current,
    retry: () => { cache.delete(key); setRetry(value => ({ key, attempt: value.key === key ? value.attempt + 1 : 1 })); } };
}
