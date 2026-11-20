import { createContext, type MouseEvent } from "react";
import type { GlobalTrackId } from "../types/music";

export const SongContextMenu = createContext(false);

/** Every track menu's width, wide enough that no action wraps. Keep TrackMenus.css in step. */
export const MENU_WIDTH = 220;

/** Keyboard button activation has no click count; a pointer contextmenu can also have detail 0. */
export function isKeyboardMenuClick(event: { type: string; detail: number }) {
  return event.type === "click" && event.detail === 0;
}

/** Suppress the clicks that precede a double-click, including clicks on nested buttons. */
export function suppressSongClick(event: MouseEvent) {
  if (isKeyboardMenuClick(event)) return;
  event.preventDefault();
  event.stopPropagation();
}

export function playSongOnDoubleClick(event: MouseEvent, play: () => void) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  play();
}

export function songMenuPosition(event: MouseEvent<HTMLElement>) {
  event.preventDefault();
  event.stopPropagation();
  if (isKeyboardMenuClick(event)) {
    const anchor = event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom, flipY: rect.top, returnFocusTo: anchor };
  }
  return { x: event.clientX, y: event.clientY, flipY: event.clientY, instant: event.type === "contextmenu" };
}

export type TrackPlaybackActions = {
  playTrack?: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
};

export function trackPlaybackActions(trackId: GlobalTrackId | null, { playTrack, playStandalone, addToQueue, playNext }: TrackPlaybackActions) {
  const action = (id: string, iconId: string, label: string, icon: string, select: (trackId: GlobalTrackId) => void) => ({
    id, iconId, label, icon, onSelect: () => { if (trackId !== null) select(trackId); },
  });
  return [
    action("standalonePlay", "menuPlayIcon", "Standalone Play", "/play.svg", playStandalone),
    ...(playTrack ? [action("normalPlay", "menuPlayFromIcon", "Play from Here", "/skip.svg", playTrack)] : []),
    action("playNext", "menuPlayNextIcon", "Play Next", "/play-next.svg", playNext),
    action("addToQueue", "menuAddToQueueIcon", "Add to Queue", "/add-to-queue.svg", addToQueue),
  ];
}

export function pauseTrackAction(onSelect: () => void) {
  return { label: "Pause", icon: "/pause.svg", onSelect };
}
