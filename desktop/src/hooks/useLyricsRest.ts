import { useEffect, useMemo, useRef, useState } from "react";
import type { TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import { cachedLyrics, loadLyrics } from "../utils/lyricsCache";
import { lyricSyncOverride } from "../utils/lyricsSyncOverrides";
import { usePlaybackTime, type PlaybackClock } from "../utils/playbackClock";

/** The lyrics rest this long after their last line ends, once it has finished highlighting. */
const SETTLE_MS = 3_000;
/** Only an instrumental ending at least this long hands the stage to the cover. */
const MIN_OUTRO_MS = 60_000;
/** Pointer or key activity brings the lyrics back for this long before they rest again. */
const WAKE_MS = 5_000;

/** Playback seconds at which the lyrics may rest, or Infinity when the song's ending is short. */
function restingFrom(track: Track | undefined, lyrics: TrackLyrics | undefined): number {
  if (!track || lyrics?.status !== "lyrics" || lyrics.sync === "none") return Infinity;
  const override = lyricSyncOverride(track.globalId);
  if (override?.unsynced) return Infinity;
  const lastMs = Math.max(-1, ...lyrics.lines
    .flatMap((line) => [line, ...line.backgroundVocals])
    .flatMap((line) => [line.endMs ?? line.startMs, ...line.segments.map((segment) => segment.endMs ?? segment.startMs)])
    .filter((time): time is number => time !== null));
  if (lastMs < 0) return Infinity;
  // Lyric time runs ahead of playback by the lyrics' offset and any saved correction.
  const lastSeconds = (lastMs - lyrics.offsetMs - (override?.correctionMs ?? 0)) / 1000;
  if (track.durationSeconds - lastSeconds < MIN_OUTRO_MS / 1000) return Infinity;
  return lastSeconds + SETTLE_MS / 1000;
}

/**
 * True while a long instrumental ending plays with nobody touching the app, so the player
 * can hand the stage to the cover. Any pointer or key activity brings the lyrics back, and
 * they rest again once it stops.
 */
export function useLyricsRest(track: Track | undefined, clock: PlaybackClock, enabled: boolean): boolean {
  const [lyrics, setLyrics] = useState(() => (track ? cachedLyrics(track) : undefined));
  useEffect(() => {
    setLyrics(enabled && track ? cachedLyrics(track) : undefined);
    if (!enabled || !track) return;
    let cancelled = false;
    void loadLyrics(track)
      .then((result) => { if (!cancelled) setLyrics(result); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [track, enabled]);
  const from = useMemo(() => restingFrom(track, lyrics), [track, lyrics]);
  const outro = usePlaybackTime(clock, (time) => time >= from) && enabled;

  // Activity just before the ending counts, so the lyrics never vanish under a moving pointer.
  const lastActivity = useRef(performance.now());
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sleepIn = (milliseconds: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => setAwake(false), milliseconds);
    };
    const wake = () => {
      lastActivity.current = performance.now();
      if (!outro) return;
      setAwake(true);
      sleepIn(WAKE_MS);
    };
    if (outro) {
      const idle = performance.now() - lastActivity.current;
      setAwake(idle < WAKE_MS);
      if (idle < WAKE_MS) sleepIn(WAKE_MS - idle);
    }
    const events = ["pointermove", "pointerdown", "wheel", "keydown"] as const;
    for (const event of events) window.addEventListener(event, wake, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, wake);
    };
  }, [enabled, outro]);

  return outro && !awake;
}
