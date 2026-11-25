import "./TrackMenus.css";
import { isTrackAvailable, useServiceAvailability } from "../hooks/useServiceAvailability";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GlobalTrackId } from "../types/music";
import { useFadeOutOnUnmount } from "../hooks/useFadeOutOnUnmount";
import { menuBounds, trackPlaybackActions, type TrackPlaybackActions } from "../utils/trackMenu";
import { TrackMenuBackdrop } from "./TrackMenuBackdrop";

type TrackPlaybackMenuProps = TrackPlaybackActions & {
  onClose: () => void;
  xPos: number;
  yPos: number;
  trackId: GlobalTrackId | null;
  openedWithKeyboard?: boolean;
  instant?: boolean;
};

export function TrackPlaybackMenu({
  onClose,
  xPos,
  yPos,
  trackId,
  openedWithKeyboard = false,
  instant = false,
  ...playback
}: TrackPlaybackMenuProps) {
  const connected = useServiceAvailability();
  const menu = useRef<HTMLDivElement>(null);
  const [keyboardNavigation, setKeyboardNavigation] = useState(openedWithKeyboard);
  useFadeOutOnUnmount(menu, !instant);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Pointer opens need focus for keyboard handling, but must not select an action.
    const target = openedWithKeyboard ? menu.current?.querySelector<HTMLButtonElement>("button") : menu.current;
    target?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  // Turns left or upward only when its real size would run past the edge of its view.
  const [flip, setFlip] = useState({ left: false, up: false });
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const bounds = menuBounds(element);
    setFlip({ left: xPos + element.offsetWidth > bounds.right, up: yPos + element.offsetHeight > bounds.bottom });
  }, [xPos, yPos]);
  if (trackId && !isTrackAvailable(trackId, connected)) return null;
  const offset = instant ? "0" : "1%";
  return (
    <TrackMenuBackdrop song={Boolean(trackId)} onClose={onClose}>
      <div
        ref={menu}
        id="trackPlaybackMenu" className="uiMenu uiMenuPopup"
        role="menu"
        tabIndex={-1}
        data-navigation={keyboardNavigation ? "keyboard" : "pointer"}
        aria-label="Track playback"
        onPointerMove={(event) => {
          setKeyboardNavigation(false);
          // Pointer movement takes over from the last keyboard selection.
          const item = (event.target as HTMLElement).closest<HTMLButtonElement>('button[role="menuitem"]');
          item?.focus({ preventScroll: true });
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Tab") { onClose(); return; }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          setKeyboardNavigation(true);
          const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : current < 0 ? (event.key === "ArrowUp" ? items.length - 1 : 0)
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}
        style={{
          animation: instant ? "none" : undefined,
          left: xPos,
          top: yPos,
          transform: `translate(
            ${flip.left ? "-100%" : offset},
            ${flip.up ? "-100%" : offset}
          )`,
          // The scale applies after the flip, so the box's own corner is always the clicked point.
          transformOrigin: "0 0",
        }}
      >
        {trackPlaybackActions(trackId, playback).map(action => (
          <button key={action.id} type="button" role="menuitem" id={action.id} className="menuItem" onClick={action.onSelect}>
            <img id={action.iconId} className="menuIcon" alt="" src={action.icon} />
            {action.label}
          </button>
        ))}
      </div>
    </TrackMenuBackdrop>
  );
}
