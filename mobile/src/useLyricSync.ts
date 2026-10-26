import { useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { defaultLyricSync, lyricSyncStorageKey, parseLyricSync, type LyricSync } from "./lyricSync";

const cache = new Map<string, LyricSync>();
let saves: Promise<unknown> = Promise.resolve();

/** Timing is saved per recording on this phone; a late read cannot overwrite a user's edit. */
export function useLyricSync(trackId: string) {
  const [result, setResult] = useState<{ value: LyricSync; loaded: boolean; error: string | null }>(() => ({ value: cache.get(trackId) ?? defaultLyricSync, loaded: cache.has(trackId), error: null }));
  useEffect(() => {
    if (!trackId || cache.has(trackId)) return;
    let disposed = false;
    void SecureStore.getItemAsync(lyricSyncStorageKey(trackId)).then(encoded => {
      if (disposed) return;
      const value = cache.get(trackId) ?? parseLyricSync(encoded);
      cache.set(trackId, value);
      setResult({ value, loaded: true, error: null });
    }).catch(() => { if (!disposed) setResult(current => ({ ...current, loaded: true, error: "Saved timing couldn’t load. Changes can still be applied." })); });
    return () => { disposed = true; };
  }, [trackId]);
  return { ...result, update: (change: (value: LyricSync) => LyricSync) => {
    const value = change(cache.get(trackId) ?? result.value);
    cache.delete(trackId);
    cache.set(trackId, value);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    setResult({ value, loaded: true, error: null });
    saves = saves.catch(() => {}).then(() => SecureStore.setItemAsync(lyricSyncStorageKey(trackId), JSON.stringify(value)));
    void saves.catch(() => setResult(current => ({ ...current, error: "Timing changed for now, but couldn’t be saved. Try again." })));
  } };
}
