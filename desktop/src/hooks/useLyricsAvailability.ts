import { useEffect, useState } from "react";
import type { TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import { cachedLyrics, loadLyrics } from "../utils/lyricsCache";

export type LyricsAvailability = "lyrics" | "none" | "pending";

function availability(lyrics: TrackLyrics): LyricsAvailability {
  if (lyrics.status === "lyrics") return "lyrics";
  // A failed lookup stays on the lyrics view, where it can be retried.
  return lyrics.status === "unavailable" && lyrics.failedProviders.length > 0 ? "lyrics" : "none";
}

/** Whether the lyrics view has anything to show for this track; only looked up while `enabled`. */
export function useLyricsAvailability(track: Track | undefined, enabled: boolean): LyricsAvailability {
  const cached = track && enabled ? cachedLyrics(track) : undefined;
  const [loaded, setLoaded] = useState<{ id: string; value: LyricsAvailability } | null>(null);
  useEffect(() => {
    if (!track || !enabled || cachedLyrics(track)) return;
    let live = true;
    void loadLyrics(track)
      .then((lyrics) => availability(lyrics), () => "lyrics" as const)
      .then((value) => { if (live) setLoaded({ id: track.globalId, value }); });
    return () => { live = false; };
  }, [track?.globalId, enabled]);
  if (!track) return "none";
  if (!enabled) return "pending";
  if (cached) return availability(cached);
  return loaded?.id === track.globalId ? loaded.value : "pending";
}
