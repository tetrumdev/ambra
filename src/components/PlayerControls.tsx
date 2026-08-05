import "./PlayerControls.css";

type PlayerControlsProps = {
  isPlaying: boolean;
  onPrevious: () => void;
  onTogglePlayback: () => void | Promise<void>;
  onNext: () => void;
};

export function PlayerControls({
  isPlaying,
  onPrevious,
  onTogglePlayback,
  onNext,
}: PlayerControlsProps) {
  return (
    <div id="controls">
      <button id="backBtn" type="button" onClick={onPrevious}>
        <img src="/back.svg" alt="Previous" />
      </button>

      <button
        id="playBtn"
        type="button"
        onClick={onTogglePlayback}
        className={isPlaying ? "pause" : "play"}
      >
        <img
          src={isPlaying ? "/Pause.svg" : "/Play.svg"}
          alt={isPlaying ? "Pause" : "Play"}
        />
      </button>

      <button id="skipBtn" type="button" onClick={onNext}>
        <img src="/skip.svg" alt="Next" />
      </button>
    </div>
  );
}
