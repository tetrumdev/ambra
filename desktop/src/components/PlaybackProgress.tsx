import type { CSSProperties } from "react";
import { useState } from "react";
import "./PlaybackProgress.css";

type PlaybackProgressProps = {
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
};

type Clock = "songLength" | "timeRemaining";

function formatTime(time: number) {
  const totalSeconds = Math.max(0, Math.floor(time));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(time / 60);
  const seconds = String(Math.floor(time % 60)).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}}`;
  } else {
    return `${minutes}:${seconds}`;
  }
}

export function PlaybackProgress({
  currentTime,
  duration,
  onSeek,
}: PlaybackProgressProps) {
  const [clockType, setClockType] = useState<Clock>("songLength");
  const songLength = Math.max(0, duration);
  const timeRemaining = Math.max(0, duration - currentTime);
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
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
        value={currentTime}
        aria-label="Playback position"
        onChange={(event) => onSeek(Number(event.target.value))}
        style={{ "--progress": `${progressPercent}%` } as CSSProperties}
      />
      <button
        id="otherTime"
        type="button"
        onClick={toggleClockType}
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
