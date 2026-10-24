import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
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
import { motion } from "../utils/motion";

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
  songMenu?: ComponentProps<typeof SongInfo>["menu"];
  track: Track | undefined;
  audioQuality?: AudioQuality | null;
  showAudioQuality?: boolean;
  clock: PlaybackClock;
  duration: number;
  isPlaying: boolean;
  previousActivation: number;
  nextActivation: number;
  playbackError?: string | null;
  /** The output on another computer the song plays on. */
  playingOn?: string | null;
  audioDecks: AudioDeckController;
  onPrevious: () => void;
  onTogglePlayback: () => void | Promise<void>;
  onNext: () => void;
  onSeek: (time: number) => void;
  onOpenBigscreen?: () => void;
  onOpenQueue?: () => void;
  /** 1 when the player moved forward, -1 when it went back; the next song slides in from that side. */
  direction?: () => number;
};

export function NowPlayingBar({
  variant,
  onOpenEntity,
  songMenu,
  track,
  audioQuality,
  showAudioQuality = false,
  onOpenBigscreen,
  clock,
  duration,
  isPlaying,
  previousActivation,
  nextActivation,
  playbackError,
  playingOn,
  audioDecks,
  onPrevious,
  onTogglePlayback,
  onNext,
  onSeek,
  onOpenQueue,
  direction,
}: NowPlayingBarProps) {
  const isEmpty = track === undefined;
  const quality = track && showAudioQuality ? formatAudioQuality(track, audioQuality) : null;

  // A new song's details ease in from the side the player moved towards, the way the big
  // cover does. Only what actually changed moves: the next song on the same album slides in
  // its title, while the album, artist and cover it shares stay put. Nothing waits on it,
  // so it takes the slower, gentler timing.
  const bar = useRef<HTMLDivElement>(null);
  const shownSong = useRef(track);
  useLayoutEffect(() => {
    const previous = shownSong.current;
    if (previous?.globalId === track?.globalId) return;
    shownSong.current = track;
    if (!bar.current || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const step = direction?.() ?? 1;
    const arrive = [{ opacity: 0, transform: `translateX(${step * 14}px)` }, { opacity: 1, transform: "none" }];
    const artists = (song: Track | undefined) => song?.artists.map((artist) => artist.name).join(", ") ?? song?.artist;
    const changed: [string, boolean][] = [
      [".songNameRow", previous?.name !== track?.name],
      ["#albumName", previous?.album !== track?.album],
      ["#artistName", artists(previous) !== artists(track)],
      // The whole thumbnail moves, not just its image, so its white backing never shows around a shrunken cover.
      ["#compactArtwork", previous?.cover !== track?.cover],
    ];
    for (const [selector, differs] of changed) {
      if (differs || !previous) bar.current.querySelector(selector)?.animate(arrive, motion.smooth);
    }
  }, [track, direction]);

  return (
    <div id="bottomInfoBar" ref={bar} data-variant={variant}>
      <div className="bottomInfoBarSurface" aria-hidden="true" />
      <AudioDecks controller={audioDecks} />
      {track && playbackError && (
        <PlaybackErrorPill key={JSON.stringify([track.globalId, playbackError])} error={playbackError} />
      )}
      {/* Kept while the player is open, so its image is already decoded when the bar returns to compact. */}
      <button
        id="compactArtwork"
        type="button"
        onClick={onOpenBigscreen}
        aria-label="Open bigscreen player"
        disabled={isEmpty}
        inert={variant !== "compact"}
      >
        {track ? (
          <TrackArtwork track={track} alt="" loading="eager" fetchPriority="high" />
        ) : (
          <img src="/ambra.png" alt="" />
        )}
      </button>
      <SongInfo track={track} onOpenEntity={onOpenEntity} menu={songMenu} playingOn={playingOn} />
      <div id="playbackCluster">
        <PlayerControls
          isPlaying={isPlaying}
          previousActivation={previousActivation}
          nextActivation={nextActivation}
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
