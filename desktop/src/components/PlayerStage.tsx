import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useLyricsAvailability } from "../hooks/useLyricsAvailability";
import { useLyricsRest } from "../hooks/useLyricsRest";
import type { Track } from "../types/music";
import { hidePointer } from "../utils/keyboardNav";
import type { PlaybackClock } from "../utils/playbackClock";
import { isPlayerScreen, type AppScreen, type LyricMotion, type PlayerView } from "../utils/preferences";
import { isSongEnding } from "../utils/songEnding";
import { AppChrome } from "./AppChrome";
import { AlbumArtwork, BackgroundArtwork } from "./BigscreenArtwork";
import { LyricsView } from "./LyricsView";

/** Dispatched on window to show a resting player's controls, as a pointer move would. */
export const WAKE_PLAYER_EVENT = "ambra:wake-player";

type PlayerStageProps = {
  screen: AppScreen;
  preferredView: PlayerView;
  isFullscreen: boolean | null;
  track: Track | undefined;
  clock: PlaybackClock;
  duration: number;
  playing: boolean;
  onSeek: (seconds: number) => void;
  motion: LyricMotion;
  autoSync: boolean;
  globalOffsetMs: number;
  animateSwirl: boolean;
  skipDirection: () => number;
  openedByKey: RefObject<boolean>;
  onExit: () => void;
  onSelectView: (view: PlayerView) => void;
};

export const PlayerStage = memo(function PlayerStage({
  screen, preferredView, isFullscreen, track, clock, duration, playing, onSeek,
  motion, autoSync, globalOffsetMs, animateSwirl, skipDirection, openedByKey, onExit, onSelectView,
}: PlayerStageProps) {
  const isPlayerView = isPlayerScreen(screen);
  // Lyrics are the chosen view, but a song without synced ones shows its cover until one with them comes back.
  const prefersLyrics = (isPlayerView ? screen : preferredView) === "lyrics";
  const lyricsAvailability = useLyricsAvailability(track, prefersLyrics);
  // While a song's lyrics are still being looked up, the layout holds where it was.
  const showLyricsRef = useRef(false);
  if (!prefersLyrics) showLyricsRef.current = false;
  else if (lyricsAvailability !== "pending") showLyricsRef.current = lyricsAvailability === "lyrics";
  const showLyrics = showLyricsRef.current;
  // The lyrics on screen; when a song has none they stay to fade out rather than vanish.
  const lyricsTrackRef = useRef(track);
  if (showLyrics) lyricsTrackRef.current = track;
  const lyricsTrack = lyricsTrackRef.current;
  // When one song's lyrics replace another's, the old view stays a moment to drift out.
  const lyricsHandoff = useRef<{ track: typeof lyricsTrack; leaving: NonNullable<typeof lyricsTrack>[] }>({ track: lyricsTrack, leaving: [] });
  // During a long instrumental ending the lyrics step aside for the cover until the pointer moves.
  // Settling back after the next song starts drifts too, as gently as the lyrics left.
  const { resting: lyricsResting, gentle: lyricsDrift } = useLyricsRest(track, clock, screen === "lyrics" && showLyrics, autoSync);
  const lyricsOnStage = showLyrics && !lyricsResting;
  // Opening the player shows its lyrics at once; switching between them and the cover fades (LyricsView.css).
  const [lyricsShown, setLyricsShown] = useState(lyricsOnStage && isPlayerView);
  const playerWasOpen = useRef(isPlayerView);
  if (lyricsShown && !(lyricsOnStage && isPlayerView)) setLyricsShown(false);
  else if (!lyricsShown && lyricsOnStage && isPlayerView && !playerWasOpen.current) setLyricsShown(true);
  useEffect(() => {
    playerWasOpen.current = isPlayerView;
    if (lyricsShown || !lyricsOnStage || !isPlayerView) return;
    // Paint the hidden state once first, so lyrics switched to fade in from behind the cover.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setLyricsShown(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [isPlayerView, lyricsOnStage, lyricsShown]);
  if (lyricsTrack?.globalId !== lyricsHandoff.current.track?.globalId) {
    const previous = lyricsHandoff.current.track;
    const leaving = lyricsHandoff.current.leaving.filter((track) => track.globalId !== lyricsTrack?.globalId);
    lyricsHandoff.current = {
      track: lyricsTrack,
      leaving: previous && lyricsShown && isPlayerView ? [...leaving, previous].slice(-2) : leaving,
    };
  }
  const leavingLyrics = lyricsHandoff.current.leaving;
  const [, settleLyricsHandoff] = useState(0);
  useEffect(() => {
    if (!leavingLyrics.length) return;
    const timer = setTimeout(() => {
      lyricsHandoff.current = { ...lyricsHandoff.current, leaving: [] };
      settleLyricsHandoff((value) => value + 1);
      // Outlasts the arriving lyrics' rise, so ending the handoff never cuts it short.
    }, 900);
    return () => clearTimeout(timer);
  }, [leavingLyrics]);

  // Idle timers read the latest duration without restarting on track changes.
  const playerDurationRef = useRef(duration);
  playerDurationRef.current = duration;
  // Before paint, so a player opened from the keyboard is never seen with its controls showing.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!isPlayerView) {
      root.removeAttribute("data-bigscreen-idle");
      return;
    }

    let idleTimer: ReturnType<typeof setTimeout>;
    // The controls fade out after a song's change, never into it.
    const becomeIdle = () => {
      if (isSongEnding(clock.get(), playerDurationRef.current)) idleTimer = setTimeout(becomeIdle, 500);
      else root.setAttribute("data-bigscreen-idle", "true");
    };
    const markActive = () => {
      root.removeAttribute("data-bigscreen-idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(becomeIdle, 10_000);
    };

    // Only a real move wakes the controls, not the page shifting under a still pointer.
    const onPointerMove = (event: PointerEvent) => {
      if (event.movementX || event.movementY) markActive();
    };

    let snapFrame = 0;
    if (openedByKey.current) {
      // Already put away rather than fading out; the fades start once the pointer moves.
      root.setAttribute("data-bigscreen-snap", "");
      root.setAttribute("data-bigscreen-idle", "true");
      snapFrame = requestAnimationFrame(() => {
        snapFrame = requestAnimationFrame(() => root.removeAttribute("data-bigscreen-snap"));
      });
    } else {
      markActive();
    }
    openedByKey.current = false;
    // The player is for watching, so the pointer gets out of the way until it moves.
    hidePointer();
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerdown", markActive);
    window.addEventListener(WAKE_PLAYER_EVENT, markActive);

    return () => {
      clearTimeout(idleTimer);
      cancelAnimationFrame(snapFrame);
      root.removeAttribute("data-bigscreen-snap");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener(WAKE_PLAYER_EVENT, markActive);
      root.removeAttribute("data-bigscreen-idle");
    };
  }, [isPlayerView, clock, openedByKey]);

  return (
    <>
      <AppChrome
        currentScreen={screen}
        playerView={showLyrics ? "lyrics" : "bigscreen"}
        lyricsAvailability={lyricsAvailability}
        isFullscreen={isFullscreen}
        onExit={onExit}
        onSelectPlayerView={onSelectView}
      />

      {(track || isPlayerView) && (
        <div className="playerStage" data-open={isPlayerView}>
          <BackgroundArtwork track={track} active={isPlayerView} animate={animateSwirl}
            playing={playing} />
          {isPlayerView && [
            ...leavingLyrics.map((track) => ({ track, leaving: true })),
            ...(lyricsTrack ? [{ track: lyricsTrack, leaving: false }] : []),
          ].map(({ track, leaving }) => <LyricsView key={track.globalId}
            track={track} clock={clock} playing={playing} onSeek={onSeek}
            motion={motion} autoSync={autoSync} globalOffsetMs={globalOffsetMs}
            shown={!leaving && lyricsShown} resting={!leaving && lyricsDrift} leaving={leaving} covered={leaving && lyricsShown} arriving={!leaving && leavingLyrics.length > 0} />)}
        </div>
      )}
      {(track || isPlayerView) && (
        <AlbumArtwork
          track={track}
          active={isPlayerView}
          layout={lyricsOnStage ? "lyrics" : "center"}
          resting={lyricsDrift}
          direction={skipDirection}
        />
      )}

    </>
  );
});
