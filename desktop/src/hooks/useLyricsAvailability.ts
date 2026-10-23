import { useEffect, useState, useSyncExternalStore } from "react";
import { needsLyricsRetry, type TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import { cachedLyrics, loadLyrics, lyricsKey, lyricsRevision, subscribeLyrics } from "../utils/lyricsCache";

export type LyricsAvailability = "lyrics" | "unsynced" | "none" | "pending";

function availability(lyrics: TrackLyrics): LyricsAvailability {
  // A partial lookup must leave the lyrics view accessible for a retry.
  if (needsLyricsRetry(lyrics)) return "lyrics";
  // Lyrics without timings can't follow the song, so the player shows the cover instead.
  if (lyrics.status === "lyrics") return lyrics.sync === "none" ? "unsynced" : "lyrics";
  return "none";
}

/** Whether the lyrics view has anything to show for this track; only looked up while `enabled`. */
export function useLyricsAvailability(track: Track | undefined, enabled: boolean): LyricsAvailability {
  // Manual retries in LyricsView can change whether the cover should step aside.
  useSyncExternalStore(subscribeLyrics, lyricsRevision);
  const cached = track && enabled ? cachedLyrics(track) : undefined;
  // Keyed like the lyrics view, so a metadata refresh mid-song follows the lookup it starts
  // instead of waiting out the superseded one.
  const key = track ? lyricsKey(track) : null;
  const [loaded, setLoaded] = useState<{ key: string; value: LyricsAvailability } | null>(null);
  useEffect(() => {
    if (!track || !key || !enabled || cachedLyrics(track)) return;
    let live = true;
    void loadLyrics(track)
      .then((lyrics) => availability(lyrics), () => "lyrics" as const)
      .then((value) => { if (live) setLoaded({ key, value }); });
    return () => { live = false; };
  }, [key, enabled]);
  if (!track) return "none";
  if (!enabled) return "pending";
  if (cached) return availability(cached);
  return loaded?.key === key ? loaded.value : "pending";
}
