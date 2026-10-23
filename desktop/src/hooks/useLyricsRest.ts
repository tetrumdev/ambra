import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { TrackLyrics } from "../types/lyrics";
import type { Track } from "../types/music";
import { cachedLyrics, loadLyrics } from "../utils/lyricsCache";
import { detectLyricOffset, MAX_LINE_MS, type DetectedOffset } from "../utils/lyricsOffset";
import { lyricSyncOverride } from "../utils/lyricsSyncOverrides";
import { usePlaybackTime, type PlaybackClock } from "../utils/playbackClock";
import { motion } from "../utils/motion";
import { useSongEnding } from "../utils/songEnding";

/** The lyrics rest this long after their last line ends, once it has finished highlighting. */
const SETTLE_MS = 3_000;
/** When the vocals clearly drop away during the last line, the lyrics rest this soon after. */
const VOCAL_SETTLE_MS = 3_000;
/** A measured ending outside the last line, give or take this, belongs to some other passage. */
const VOCAL_END_BEFORE_MS = 2_000;
const VOCAL_END_AFTER_MS = 5_000;
/** Only an instrumental ending at least this long hands the stage to the cover. */
const MIN_OUTRO_MS = 60_000;
/** A heard ending outranks a last line timed lazily through the outro, so a shorter one is enough. */
const MIN_HEARD_OUTRO_MS = 20_000;
/** Pointer or key activity brings the lyrics back for this long before they rest again. */
const WAKE_MS = 5_000;

/** Playback seconds at which the lyrics may rest, or Infinity when the song's ending is short. */
function restingFrom(track: Track | undefined, lyrics: TrackLyrics | undefined, detected: DetectedOffset | undefined): number {
  if (!track || lyrics?.status !== "lyrics" || lyrics.sync === "none") return Infinity;
  const override = lyricSyncOverride(track.globalId);
  if (override?.unsynced) return Infinity;
  const spans = lyrics.lines
    .flatMap((line) => [line, ...line.backgroundVocals])
    .filter((line) => line.text.trim())
    .flatMap((line) => [[line.startMs, line.endMs ?? line.startMs], ...line.segments.map((segment) => [segment.startMs, segment.endMs ?? segment.startMs])])
    .filter((span): span is [number, number] => span[0] !== null && span[1] !== null);
  if (!spans.length) return Infinity;
  const [lastStartMs, lastMs] = spans.reduce((latest, span) => (span[1] > latest[1] ? span : latest));
  // Analysis looks no further than this into the last line; a final line is sometimes timed as
  // held through the whole outro. Without a measured ending, its full timing is waited out.
  const lastSungMs = Math.min(lastMs, lastStartMs + MAX_LINE_MS);
  // Lyric time runs ahead of playback by the lyrics' offset and any correction, saved or detected.
  const correctionMs = override?.correctionMs ?? (detected?.confident ? detected.correctionMs : 0);
  const lastPlaybackMs = lastMs - lyrics.offsetMs - correctionMs;
  const lastStartPlaybackMs = lastStartMs - lyrics.offsetMs - correctionMs;
  // Auto-sync's analysis hears when the singing actually stops, which line timings only approximate.
  const vocalEndMs = detected?.vocalEndMs ?? null;
  const heard = vocalEndMs !== null
    && vocalEndMs >= lastStartPlaybackMs - VOCAL_END_BEFORE_MS
    && vocalEndMs <= lastSungMs - lyrics.offsetMs - correctionMs + VOCAL_END_AFTER_MS;
  const endSeconds = (heard ? vocalEndMs : lastPlaybackMs) / 1000;
  if (track.durationSeconds - endSeconds < (heard ? MIN_HEARD_OUTRO_MS : MIN_OUTRO_MS) / 1000) return Infinity;
  return endSeconds + (heard ? VOCAL_SETTLE_MS : SETTLE_MS) / 1000;
}

/**
 * `resting` is true while a long instrumental ending plays with nobody touching the app, so
 * the player can hand the stage to the cover. Any pointer or key activity brings the lyrics
 * back, and they rest again once it stops. `gentle` also covers the rest ending on its own,
 * when the next song starts, so the lyrics drift back as slowly as they left; being woken by
 * the listener stays quick.
 */
export function useLyricsRest(track: Track | undefined, clock: PlaybackClock, enabled: boolean, autoSync: boolean): { resting: boolean; gentle: boolean } {
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
  // Shares the lyrics view's auto-sync analysis, which also measures where the vocals end.
  const [detected, setDetected] = useState<DetectedOffset>();
  useEffect(() => {
    setDetected(undefined);
    if (!enabled || !autoSync || !isTauri() || !track || lyrics?.status !== "lyrics" || lyrics.sync === "none") return;
    if (lyricSyncOverride(track.globalId)?.unsynced) return;
    let cancelled = false;
    void detectLyricOffset(track, lyrics, true)
      .then((result) => { if (!cancelled) setDetected(result); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [track, lyrics, enabled, autoSync]);
  const from = useMemo(() => restingFrom(track, lyrics, detected), [track, lyrics, detected]);
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

  // In the song's last seconds the lyrics stay where they are, leaving the stage to the next song's arrival.
  const ending = useSongEnding(clock, track?.durationSeconds) && enabled;
  const held = useRef(false);
  if (!ending) held.current = outro && !awake;
  const resting = held.current;
  // Read during render, so the moves this render starts already take the drifting timing.
  const settle = useRef({ resting, until: 0 });
  if (settle.current.resting && !resting && !awake && enabled) settle.current.until = performance.now() + motion.drift.duration;
  if (resting) settle.current.until = 0;
  settle.current.resting = resting;
  const settling = performance.now() < settle.current.until;
  const [, settled] = useState(0);
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => settled((value) => value + 1), settle.current.until - performance.now());
    return () => clearTimeout(timer);
  }, [settling]);

  return { resting, gentle: resting || settling };
}
