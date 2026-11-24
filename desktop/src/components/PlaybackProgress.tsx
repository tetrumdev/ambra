import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { haptic } from "../utils/haptics";
import { motion } from "../utils/motion";
import { reducedMotion } from "../utils/reducedMotion";
import { usePlaybackTime, type PlaybackClock } from "../utils/playbackClock";
import "./PlaybackProgress.css";

type PlaybackProgressProps = {
  clock: PlaybackClock;
  duration: number;
  onSeek: (time: number) => void;
  disabled?: boolean;
  /** Changes with each new song, so the bar shows the change instead of gliding back. */
  songKey?: string;
};

type Clock = "songLength" | "timeRemaining";

/** A CSS cubic-bezier curve as a function, for animating outside CSS. */
function cubicBezier([x1, y1, x2, y2]: number[]) {
  const axis = (first: number, second: number, t: number) => 3 * first * t * (1 - t) ** 2 + 3 * second * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    let low = 0, high = 1;
    for (let step = 0; step < 20; step++) {
      const middle = (low + high) / 2;
      if (axis(x1, x2, middle) < x) low = middle; else high = middle;
    }
    return axis(y1, y2, (low + high) / 2);
  };
}

const glideEase = cubicBezier(motion.smooth.easing.match(/[\d.]+/g)!.map(Number));
/** The old song's bar speeds up as it leaves, never settling: it's going away, not arriving. */
const leaveEase = cubicBezier([0.4, 0, 1, 1]);
/** A jump bigger than this many seconds glides instead of snapping. */
const GLIDE_AFTER_SECONDS = 1.5;
/** A new song wipes the old one's bar off to the right. Going back to the one before, the same
    happens the other way: a bar sweeps in from the right, then draws back to the new playhead. */
const WIPE_MS = 450;
/** Skipping ahead, the old bar first fills the rest of the way, taking this long for the whole bar,
    to show the whole song was skipped. */
const FILL_MS = 350;
/** How far, as a share of the bar, the wiping bar's trailing edge fades over. The fade starts
    outside the bar and slides in, so it never pops into view. */
const WIPE_FADE = 0.25;
/** A jump back this soon after the song changed, or from this close to the end, is a new song. */
const NEW_SONG_WITHIN_MS = 2000;
const NEAR_END = 0.98;

function formatTime(time: number) {
  const totalSeconds = Math.max(0, Math.floor(time));

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(Math.ceil(totalSeconds % 60)).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
  } else {
    return `${minutes}:${seconds}`;
  }
}

export function PlaybackProgress({
  clock,
  duration,
  onSeek,
  disabled = false,
  songKey,
}: PlaybackProgressProps) {
  const playbackTime = usePlaybackTime(clock);
  // While pressed, the bar shows where it would seek; one seek goes out on release.
  const [scrub, setScrub] = useState<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const seek = useRef(onSeek);
  seek.current = onSeek;
  const shownTime = scrub ?? playbackTime;
  // Skips and seeks glide the bar and time to their new place; playing and dragging follow exactly.
  const target = duration > 0 ? Math.min(1, Math.max(0, shownTime / duration)) : 0;
  const glide = useRef<{ from: number; start: number } | null>(null);
  const shown = useRef(target);
  const press = useRef<"up" | "down" | "glided">("up");
  const [, setFrame] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ scrub, duration });
  latest.current = { scrub, duration };
  // The old song's bar, from where it was, wiping off while the new one fills from the start.
  const wipe = useRef<{ from: number; start: number; back: boolean } | null>(null);
  const song = useRef(songKey);
  // The songs played to get here, latest last: coming back to the one before is going back.
  const trail = useRef<string[]>(songKey === undefined ? [] : [songKey]);
  const wentBack = useRef(false);
  const songChangedAt = useRef(-Infinity);
  const now = performance.now();
  // A moment with no song (one loading) isn't a change of song.
  if (songKey !== undefined && song.current !== songKey) {
    const first = song.current === undefined;
    wentBack.current = trail.current[trail.current.length - 2] === songKey;
    if (wentBack.current) trail.current.pop();
    else trail.current = [...trail.current.slice(-49), songKey];
    song.current = songKey;
    songChangedAt.current = now;
    // A new song wipes at once, even near the start where its start is no jump at all. If that
    // start already arrived, the bar was gliding back from where the old song was.
    if (!first && !reducedMotion()) {
      wipe.current = { from: glide.current?.from ?? shown.current, start: now, back: wentBack.current };
      glide.current = null;
      shown.current = target;
    }
  }
  // The duration the bar was last drawn with: the next song's can arrive with its start, or be
  // unknown (0) for a moment, and the jump is measured against the song it left.
  const shownDuration = useRef(duration);
  // Starts a glide or a wipe for a jump in position. The bar is drawn every frame, which can
  // be before this renders, so drawing checks first too.
  const follow = (target: number, duration: number, now: number) => {
    if (glide.current && now - glide.current.start >= motion.smooth.duration) glide.current = null;
    const jump = target - shown.current;
    if (glide.current || press.current === "glided" || reducedMotion()
      || Math.abs(jump) * Math.max(duration, shownDuration.current, 1) <= GLIDE_AFTER_SECONDS) return false;
    const changed = now - songChangedAt.current < NEW_SONG_WITHIN_MS;
    const newSong = press.current === "up" && jump < 0 && (changed || shown.current >= NEAR_END);
    if (newSong) {
      // One wipe per song: the next song's length and start can land in separate steps.
      wipe.current ??= { from: shown.current, start: now, back: changed && wentBack.current };
      shown.current = target;
      return false;
    }
    glide.current = { from: shown.current, start: now };
    if (press.current === "down") press.current = "glided";
    return true;
  };
  follow(target, duration, now);
  const gliding = glide.current !== null;
  // The bar is drawn every frame from the clock's smoothed time, so it moves steadily rather than
  // stepping with each position report; it is set on the element, without rerendering.
  useEffect(() => {
    let frame = requestAnimationFrame(function paint(now) {
      const { scrub, duration } = latest.current;
      const time = scrub ?? clock.getSmooth();
      const target = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;
      // A glide started here shows its moving time too.
      if (follow(target, duration, now)) setFrame(count => count + 1);
      if (duration > 0) shownDuration.current = duration;
      shown.current = glide.current
        ? glide.current.from + (target - glide.current.from) * glideEase((now - glide.current.start) / motion.smooth.duration)
        : target;
      input.current?.style.setProperty("--progress", `${shown.current * 100}%`);
      // The old bar: clear until `clear`, fading in to solid at `solid`, solid until `end`,
      // fading out to clear at `fadeOut`.
      const fillMs = wipe.current && !wipe.current.back ? FILL_MS * (1 - wipe.current.from) : 0;
      const wipeMs = wipe.current?.back ? WIPE_MS + motion.smooth.duration : fillMs + WIPE_MS;
      if (wipe.current && now - wipe.current.start >= wipeMs) wipe.current = null;
      // The old bar, left as it was until covered.
      let held = 0;
      let clear = 1, solid = 1, end = 1, fadeOut = 1;
      if (wipe.current) {
        const { from, back } = wipe.current;
        const elapsed = now - wipe.current.start;
        const wiped = leaveEase(Math.max(0, elapsed - fillMs) / WIPE_MS);
        if (back && elapsed < WIPE_MS) {
          // Sweeping in from the right over the old bar, its faded edge first, slowing as it covers.
          const covered = 1 - leaveEase(1 - elapsed / WIPE_MS);
          held = from;
          clear = 1 - (1 + WIPE_FADE) * covered;
          solid = clear + WIPE_FADE;
        } else if (back) {
          // Then drawing back to the new song's playhead, settling onto it.
          clear = solid = -1;
          end = fadeOut = 1 + (shown.current - 1) * glideEase((elapsed - WIPE_MS) / motion.smooth.duration);
        } else if (elapsed < fillMs) {
          // Filling the rest of the bar first.
          clear = solid = -1;
          end = fadeOut = from + (1 - from) * glideEase(elapsed / fillMs);
        } else {
          // Then leaving right: the faded left edge slides in from before the start.
          clear = -WIPE_FADE + (1 + WIPE_FADE) * wiped;
          end = fadeOut = 1;
          solid = Math.min(clear + WIPE_FADE, end);
        }
      }
      const style = input.current?.style;
      style?.setProperty("--wipe-held", `${held * 100}%`);
      style?.setProperty("--wipe-clear", `${clear * 100}%`);
      style?.setProperty("--wipe-solid", `${solid * 100}%`);
      style?.setProperty("--wipe-end", `${end * 100}%`);
      style?.setProperty("--wipe-fade-out", `${fadeOut * 100}%`);
      frame = requestAnimationFrame(paint);
    });
    return () => cancelAnimationFrame(frame);
  }, [clock]);
  useEffect(() => {
    if (!gliding) return;
    let frame = requestAnimationFrame(function tick() {
      setFrame(count => count + 1);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [gliding]);
  useEffect(() => {
    const release = (event: PointerEvent) => {
      if (press.current === "up") return;
      press.current = "up";
      const time = pendingSeek.current;
      pendingSeek.current = null;
      if (time !== null && event.type === "pointerup") seek.current(time);
      setScrub(null);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);
  const currentTime = shown.current * duration;
  // Scrubbing ticks at every 5% of the song it crosses.
  const lastSeek = useRef(0);
  const notch = (time: number) => (duration > 0 ? Math.floor((time / duration) * 20) : 0);
  const [clockType, setClockType] = useState<Clock>("songLength");
  const songLength = Math.max(0, duration);
  const timeRemaining = Math.max(0, duration - currentTime);
  const progressPercent = shown.current * 100;
  const otherTime =
    clockType === "songLength"
      ? formatTime(songLength)
      : `-${formatTime(timeRemaining)}`;

  const toggleClockType = () => {
    setClockType((currentClock) =>
      currentClock === "songLength" ? "timeRemaining" : "songLength",
    );
  };

  return (
    <div id="progressContainer">
      <span id="currentTime">{formatTime(currentTime)}</span>
      <input
        ref={input}
        id="progressBar"
        type="range"
        min="0"
        max={duration || 1}
        step="0.01"
        value={shownTime}
        aria-label="Playback position"
        disabled={disabled}
        onPointerDown={() => { lastSeek.current = playbackTime; press.current = "down"; }}
        onChange={(event) => {
          const time = Number(event.target.value);
          if (notch(time) !== notch(lastSeek.current)) haptic();
          lastSeek.current = time;
          // Arrow keys seek at once; a press waits for its release.
          if (press.current === "up") onSeek(time);
          else { pendingSeek.current = time; setScrub(time); }
        }}
        style={{ "--progress": `${progressPercent}%` } as CSSProperties}
      />
      <button
        id="otherTime"
        type="button"
        onClick={toggleClockType}
        disabled={disabled}
        aria-label={
          clockType === "songLength"
            ? "Show time remaining"
            : "Show total song length"
        }
      >
        {otherTime}
      </button>
    </div>
  );
}
