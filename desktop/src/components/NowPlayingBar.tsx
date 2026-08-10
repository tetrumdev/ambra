import type { AudioDeckController } from "../hooks/useAudioPlayer";
import type { Track } from "../types/music";
import "./NowPlayingBar.css";
import { AudioDecks } from "./AudioDecks";
import { PlaybackProgress } from "./PlaybackProgress";
import { PlayerControls } from "./PlayerControls";
import { SongInfo } from "./SongInfo";
import { ExtraCtrls } from "./ExtraCtrls.tsx";

type PlayerBarVariant = "expanded" | "compact";

type NowPlayingBarProps = {
  variant: PlayerBarVariant;
  track: Track | undefined;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  audioDecks: AudioDeckController;
  onPrevious: () => void;
  onTogglePlayback: () => void | Promise<void>;
  onNext: () => void;
  onSeek: (time: number) => void;
  onOpenBigscreen?: () => void;
  onOpenQueue?: () => void;
};

export function NowPlayingBar({
  variant,
  track,
  onOpenBigscreen,
  currentTime,
  duration,
  isPlaying,
  audioDecks,
  onPrevious,
  onTogglePlayback,
  onNext,
  onSeek,
  onOpenQueue,
}: NowPlayingBarProps) {
  const isEmpty = track === undefined;

  return (
    <div id="bottomInfoBar" data-variant={variant}>
      <AudioDecks controller={audioDecks} />
      {variant === "compact" && (
        <button
          id="compactArtwork"
          type="button"
          onClick={onOpenBigscreen}
          aria-label="Open bigscreen player"
          disabled={isEmpty}
        >
          <img src={track?.cover ?? "/ambra.png"} alt="" />
        </button>
      )}
      <SongInfo track={track} />
      <div id="playbackCluster">
        <PlayerControls
          isPlaying={isPlaying}
          onPrevious={onPrevious}
          onTogglePlayback={onTogglePlayback}
          onNext={onNext}
          disabled={isEmpty}
        />
        <PlaybackProgress
          currentTime={currentTime}
          duration={duration}
          onSeek={onSeek}
          disabled={isEmpty}
        />
      </div>
      <div id="extraCtrlsCluster">
        <ExtraCtrls onOpenQueue={onOpenQueue} />
      </div>
    </div>
  );
}
