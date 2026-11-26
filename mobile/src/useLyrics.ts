import { useEffect, useState } from "react";
import { needsLyricsRetry, type TrackLyrics } from "../../desktop/src/utils/lyricsWire";
import { serverAddress, trackLyrics, type Track } from "./client";
import { lyricsKey } from "./lyricsModel";

const cache = new Map<string, { lyrics: TrackLyrics; expires: number }>();
/** Requests under way, shared: opening lyrics joins the one a song change already started. */
const loading = new Map<string, Promise<TrackLyrics>>();
type Result = { key: string; attempt: number; lyrics?: TrackLyrics; error?: string };

const keyOf = (track: Track) => `${serverAddress()}:${lyricsKey(track)}`;

function cachedLyrics(key: string) {
  const entry = cache.get(key);
  return entry && entry.expires > Date.now() ? entry.lyrics : undefined;
}

function load(track: Track, key: string): Promise<TrackLyrics> {
  const pending = loading.get(key);
  if (pending) return pending;
  // Not cancelled when a screen closes: another may be waiting on it, and the answer is kept.
  const request = trackLyrics(track, new AbortController().signal).then(lyrics => {
    if (!needsLyricsRetry(lyrics)) {
      cache.delete(key);
      cache.set(key, { lyrics, expires: Date.now() + 30 * 60_000 });
      if (cache.size > 12) cache.delete(cache.keys().next().value!);
    }
    return lyrics;
  }).finally(() => loading.delete(key));
  loading.set(key, request);
  return request;
}

/** Loads lyrics ahead of being shown: the playing song's and the next one's. */
export function prefetchLyrics(track: Track | null | undefined) {
  if (!track) return;
  const key = keyOf(track);
  if (!cachedLyrics(key)) void load(track, key).catch(() => {});
}

export function useLyrics(track: Track | null, active: boolean) {
  const key = track ? keyOf(track) : "";
  const [result, setResult] = useState<Result>({ key: "", attempt: 0 });
  const [retry, setRetry] = useState({ key: "", attempt: 0 });
  const attempt = retry.key === key ? retry.attempt : 0;
  useEffect(() => {
    if (!track || !active || cachedLyrics(key)) return;
    let disposed = false;
    void load(track, key).then(lyrics => {
      if (!disposed) setResult({ key, attempt, lyrics });
    }).catch(error => {
      if (!disposed) setResult({ key, attempt, error: error instanceof Error ? error.message : "Couldn't load lyrics." });
    });
    return () => { disposed = true; };
    // The key includes every piece of lookup metadata; position reports do not restart a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, attempt]);
  const cached = cachedLyrics(key);
  const current = result.key === key && result.attempt === attempt ? result : undefined;
  return { key, lyrics: cached ?? current?.lyrics, error: current?.error, loading: active && !cached && !current,
    retry: () => { cache.delete(key); setRetry(value => ({ key, attempt: value.key === key ? value.attempt + 1 : 1 })); } };
}
