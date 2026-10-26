import "./TrackMenus.css";
import { isTrackAvailable, useServiceAvailability } from "../hooks/useServiceAvailability";
import { useEffect, useRef } from "react";
import type { GlobalTrackId } from "../types/music";
import { useFadeOutOnUnmount } from "../hooks/useFadeOutOnUnmount";
import { MENU_WIDTH } from "../utils/trackMenu";

type TrackPlaybackMenuProps = {
  onClose: () => void;
  xPos: number;
  yPos: number;
  trackId: GlobalTrackId | null;
  playTrack?: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
};

export function TrackPlaybackMenu({
  onClose,
  xPos,
  yPos,
  trackId,
  playTrack,
  playStandalone,
  addToQueue,
  playNext,
}: TrackPlaybackMenuProps) {
  const connected = useServiceAvailability();
  const menu = useRef<HTMLDivElement>(null);
  useFadeOutOnUnmount(menu);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  if (trackId && !isTrackAvailable(trackId, connected)) return null;
  return (
    <div id="trackMenuBackdrop" onClick={onClose}>
      <div
        ref={menu}
        id="trackPlaybackMenu"
        role="menu"
        aria-label="Track playback"
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Tab") { onClose(); return; }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}
        style={{
          left: xPos,
          top: yPos,
          transform: `translate(
            ${xPos >= window.innerWidth - MENU_WIDTH ? "-100%" : "1%"},
            ${yPos >= window.innerHeight - 250 ? "-100%" : "1%"}
          )`,
          // The scale applies after the flip, so the box's own corner is always the clicked point.
          transformOrigin: "0 0",
        }}
      >
        <button type="button" role="menuitem"
          id="standalonePlay"
          className="menuItem"
          onClick={() => {
            if (trackId !== null) playStandalone(trackId);
          }}
        >
          <img id="menuPlayIcon" className="menuIcon" alt="" src="/play.svg" />
          Standalone Play
        </button>
        {playTrack && (
          <button type="button" role="menuitem"
            id="normalPlay"
            className="menuItem"
            onClick={() => {
              if (trackId !== null) playTrack(trackId);
            }}
          >
            <img id="menuPlayFromIcon" className="menuIcon" alt="" src="/skip.svg" />
            Play from Here
          </button>
        )}
        <button type="button" role="menuitem"
          id="playNext"
          className="menuItem"
          onClick={() => {
            if (trackId !== null) playNext(trackId);
          }}
        >
          <img id="menuPlayNextIcon" className="menuIcon" alt="" src="/play-next.svg" />
          Play Next
        </button>
        <button type="button" role="menuitem"
          id="addToQueue"
          className="menuItem"
          onClick={() => {
            if (trackId !== null) addToQueue(trackId);
          }}
        >
          <img
            id="menuAddToQueueIcon"
            className="menuIcon" alt=""
            src="/add-to-queue.svg"
          />
          Add to Queue
        </button>
      </div>
    </div>
  );
}
