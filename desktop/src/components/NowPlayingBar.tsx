import { useState } from "react";
import type { BrowseEntity } from "../utils/browse";
import type { AudioDeckController } from "../hooks/useAudioPlayer";
import type { AudioQuality, Track } from "../types/music";
import { formatAudioQuality } from "../utils/audioQuality";
import type { PlaybackClock } from "../utils/playbackClock";
import "./NowPlayingBar.css";
import { AudioDecks } from "./AudioDecks";
import { PlaybackProgress } from "./PlaybackProgress";
import { PlayerControls } from "./PlayerControls";
import { SongInfo } from "./SongInfo";
import { ExtraCtrls } from "./ExtraCtrls.tsx";
import { TrackArtwork } from "./TrackArtwork";

type PlayerBarVariant = "expanded" | "compact";

function PlaybackErrorPill({ error }: { error: string }) {
  const [dismissed, setDismissed] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  const copyError = async () => {
    try {
      await navigator.clipboard.writeText(error);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  if (dismissed) return null;

  return (
    <div className="playbackError" role="alert">
      <button
        type="button"
        className="playbackErrorCopy"
        onClick={copyError}
        aria-label="Copy playback error details"
        title={`${error}\nClick to copy full error details`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1" />
        </svg>
        <span>{copyStatus === "copied" ? "Error copied" : copyStatus === "failed" ? "Copy failed · Retry" : "Playback error"}</span>
      </button>
      <button
        type="button"
        className="playbackErrorDismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss playback error"
        title="Dismiss error"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <path d="m3 3 6 6m0-6-6 6" />
        </svg>
      </button>
    </div>
  );
}

type NowPlayingBarProps = {
  variant: PlayerBarVariant;
  onOpenEntity: (entity: BrowseEntity) => void;
  track: Track | undefined;
  audioQuality?: AudioQuality | null;
  showAudioQuality?: boolean;
  clock: PlaybackClock;
  duration: number;
  isPlaying: boolean;
  playbackError?: string | null;
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
  clock,
  duration,
  isPlaying,
  playbackError,
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
      {track && playbackError && (
        <PlaybackErrorPill key={JSON.stringify([track.globalId, playbackError])} error={playbackError} />
      )}
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
            clock={clock}
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
