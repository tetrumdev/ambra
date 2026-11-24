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
/** A jump bigger than this many seconds glides instead of snapping. */
const GLIDE_AFTER_SECONDS = 1.5;

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
  if (glide.current && performance.now() - glide.current.start >= motion.smooth.duration) glide.current = null;
  if (!glide.current && press.current !== "glided" && !reducedMotion()
    && Math.abs(target - shown.current) * Math.max(duration, 1) > GLIDE_AFTER_SECONDS) {
    glide.current = { from: shown.current, start: performance.now() };
    if (press.current === "down") press.current = "glided";
  }
  shown.current = glide.current
    ? glide.current.from + (target - glide.current.from) * glideEase((performance.now() - glide.current.start) / motion.smooth.duration)
    : target;
  const gliding = glide.current !== null;
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
