import { useLayoutEffect, useRef, useState } from "react";
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
import { observeCompactArtwork, rememberCompactArtwork } from "../utils/compactArtwork";
import { motion } from "../utils/motion";

type PlayerBarVariant = "expanded" | "compact";

/** What glides between the two layouts; the title also eases between its two sizes, the bar between its two widths.
    The text lines' clipped edges travel with them, so a line never shows more or less of itself in one jump. */
const GLIDING = [
  ["#songName", "font"],
  ["#artistName", "line"],
  ["#controls", "none"],
  ["#currentTime", "none"],
  ["#progressBar", "width"],
  ["#otherTime", "none"],
  [".playbackQuality", "none"],
] as const;

type Placement = { rect: DOMRect; fontSize: number };

function measure(bar: HTMLElement) {
  const placements = new Map<string, Placement>();
  placements.set("bar", { rect: bar.getBoundingClientRect(), fontSize: 0 });
  for (const [selector] of GLIDING) {
    const element = bar.querySelector<HTMLElement>(selector);
    if (element) placements.set(selector, { rect: element.getBoundingClientRect(), fontSize: parseFloat(getComputedStyle(element).fontSize) });
  }
  return placements;
}

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

  // Switching layouts, everything glides from where it was on screen to its new place.
  // The old places are read while the old layout is still in the DOM.
  const bar = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const laidOutAs = useRef(variant);
  const before = useRef<Map<string, Placement> | null>(null);
  const glides = useRef<Animation[]>([]);
  if (laidOutAs.current !== variant) {
    laidOutAs.current = variant;
    rememberCompactArtwork();
    before.current = bar.current ? measure(bar.current) : null;
  }
  useLayoutEffect(() => {
    const from = before.current;
    before.current = null;
    const element = bar.current;
    if (!from || !element) return;
    for (const glide of glides.current) glide.cancel();
    glides.current = [];
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timing = motion.smooth;
    const to = measure(element);
    const barFrom = from.get("bar")?.rect;
    const barTo = to.get("bar")?.rect;
    if (barFrom && barTo && surface.current) {
      glides.current.push(surface.current.animate(
        [{ transform: `translateY(${barFrom.top - barTo.top}px)` }, { transform: "none" }],
        timing,
      ));
    }
    for (const [selector, resize] of GLIDING) {
      const old = from.get(selector);
      const now = to.get(selector);
      const target = element.querySelector<HTMLElement>(selector);
      if (!old || !now || !target || !now.rect.width || !now.rect.height) continue;
      const scaleX = resize === "font" ? old.fontSize / now.fontSize : resize === "width" ? old.rect.width / now.rect.width : 1;
      const scaleY = resize === "font" ? scaleX : 1;
      const dx = old.rect.left - now.rect.left;
      const dy = old.rect.top + old.rect.height / 2 - (now.rect.top + now.rect.height / 2);
      glides.current.push(target.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`, transformOrigin: "0 50%" },
          { transform: "none", transformOrigin: "0 50%" },
        ],
        timing,
      ));
      if (resize === "font" || resize === "line") {
        glides.current.push(target.animate(
          [{ width: `${old.rect.width / scaleX}px` }, { width: `${now.rect.width}px` }],
          timing,
        ));
      }
    }
    // The album line only exists in the larger layout, so it fades in once the title has made room.
    const album = variant === "expanded" ? element.querySelector<HTMLElement>("#albumName") : null;
    if (album) glides.current.push(album.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: motion.smooth.duration * 0.4, easing: "ease", fill: "backwards" }));
  }, [variant]);

  return (
    <div id="bottomInfoBar" ref={bar} data-variant={variant}>
      <div className="bottomInfoBarSurface" ref={surface} aria-hidden="true" />
      <AudioDecks controller={audioDecks} />
      {track && playbackError && (
        <PlaybackErrorPill key={JSON.stringify([track.globalId, playbackError])} error={playbackError} />
      )}
      {/* Kept while the player is open, so its image is loaded and decoded when the cover lands back on it. */}
      <button
        id="compactArtwork"
        ref={observeCompactArtwork}
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
