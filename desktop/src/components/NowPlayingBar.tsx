import type { BrowseEntity } from "../utils/browse";
import type { AudioDeckController } from "../hooks/useAudioPlayer";
import type { AudioQuality, Track } from "../types/music";
import { formatAudioQuality } from "../utils/audioQuality";
import "./NowPlayingBar.css";
import { AudioDecks } from "./AudioDecks";
import { PlaybackProgress } from "./PlaybackProgress";
import { PlayerControls } from "./PlayerControls";
import { SongInfo } from "./SongInfo";
import { ExtraCtrls } from "./ExtraCtrls.tsx";
import { TrackArtwork } from "./TrackArtwork";

type PlayerBarVariant = "expanded" | "compact";

type NowPlayingBarProps = {
  variant: PlayerBarVariant;
  onOpenEntity: (entity: BrowseEntity) => void;
  track: Track | undefined;
  audioQuality?: AudioQuality | null;
  showAudioQuality?: boolean;
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
  onOpenEntity,
  track,
  audioQuality,
  showAudioQuality = false,
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
  const quality = track && showAudioQuality ? formatAudioQuality(track, audioQuality) : null;

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
          {track ? (
            <TrackArtwork track={track} alt="" loading="eager" fetchPriority="high" />
          ) : (
            <img src="/ambra.png" alt="" />
          )}
        </button>
      )}
      <SongInfo track={track} onOpenEntity={onOpenEntity} />
      <div id="playbackCluster">
        <PlayerControls
          isPlaying={isPlaying}
          onPrevious={onPrevious}
          onTogglePlayback={onTogglePlayback}
          onNext={onNext}
          disabled={isEmpty}
        />
        <div className="playbackReadout">
          <PlaybackProgress
            currentTime={currentTime}
            duration={duration}
            onSeek={onSeek}
            disabled={isEmpty}
          />
          {quality && (
            <div className="playbackQuality" role="group" aria-label="Audio quality" data-tooltip={quality.description}>
              <span className="playbackQualityName">{quality.name}</span>
              <span className="playbackQualityDetails">{quality.details}</span>
            </div>
          )}
        </div>
      </div>
      <div id="extraCtrlsCluster">
        <ExtraCtrls onOpenQueue={onOpenQueue} />
      </div>
    </div>
  );
}
