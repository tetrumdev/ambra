import { useEffect, useRef } from "react";
import { refreshTrackMetadata } from "../api/server";
import type { Track } from "../types/music";

const MAX_CONCURRENT_REFRESHES = 4;
const MAX_TRACKS_PER_SESSION = 500;

// Provider artwork URLs can rot while a track sits in a playlist or cache
// (covers move, releases are re-uploaded). Refresh persisted streaming tracks
// against the server once it is reachable so artwork, palette, and playback
// metadata recover instead of failing on every view.
export function useStaleTrackRefresh(
  tracks: Track[],
  isServerReachable: boolean,
  onRefreshedTrack: (track: Track) => void,
) {
  const refreshedRef = useRef(new Set<string>());
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const onRefreshedRef = useRef(onRefreshedTrack);
  onRefreshedRef.current = onRefreshedTrack;

  useEffect(() => {
    if (!isServerReachable) return;

    const pending = tracksRef.current
      .filter(
        (track) =>
          track.provider !== "local" &&
          !refreshedRef.current.has(track.globalId),
      )
      .slice(0, MAX_TRACKS_PER_SESSION);
    if (pending.length === 0) return;
    for (const track of pending) refreshedRef.current.add(track.globalId);

    let cancelled = false;
    const controller = new AbortController();
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_REFRESHES, pending.length) },
      async () => {
        while (!cancelled) {
          const track = pending.shift();
          if (!track) return;
          try {
            const fresh = await refreshTrackMetadata(
              track,
              controller.signal,
            );
            if (cancelled) return;
            if (
              fresh.cover !== track.cover ||
              fresh.nativeCover !== track.nativeCover ||
              fresh.audio !== track.audio ||
              fresh.name !== track.name ||
              fresh.album !== track.album
            ) {
              onRefreshedRef.current(fresh);
            }
          } catch {
            // Unresolvable tracks keep their cached data; artwork falls back.
          }
        }
      },
    );

    void Promise.all(workers);

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isServerReachable]);
}
