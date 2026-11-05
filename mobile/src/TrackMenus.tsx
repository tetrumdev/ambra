import { useCallback, useState, type ReactNode } from "react";
import type { Track } from "../../desktop/src/types/music";
import { albumForTrack, artistForTrack } from "../../desktop/src/utils/browse";
import { changeQueue, offlineActive, type QueueItem } from "./client";
import { isDownloadable, onPhone, onServer, removePhoneDownloads, removeServerDownloads } from "./downloads";
import { addToLibrary, inLibrary } from "./library";
import { Menu, type MenuAction } from "./Menu";
import { useNavigation, useRun } from "./navigation";
import { enqueueEntries, playEntries } from "./queueModel";
import { CreditsSheet, PlaylistPicker, openDownloadSheet } from "./Sheets";

/** Where the song is listed, for the edit menu's Remove action ("Remove from Playlist"…). */
export type RemoveAction = { label: string; run: (track: Track) => Promise<unknown> };

type Open =
  | { kind: "playback"; index: number; entries: QueueItem[]; tracks: Track[] }
  | { kind: "edit"; track: Track }
  | { kind: "playlist"; track: Track }
  | { kind: "credits"; track: Track };

/**
 * Desktop's two song menus: holding a song opens its playback menu (TrackPlaybackMenu),
 * its ⋯ button the edit menu (TrackCollectionMenu, with Download).
 */
export function useTrackMenus(remove?: RemoveAction): {
  openPlayback(index: number, entries: QueueItem[], tracks: Track[]): void;
  openEdit(track: Track): void;
  menus: ReactNode;
} {
  const { view, push, onMenuVisibilityChange } = useNavigation();
  const run = useRun();
  const [open, setOpen] = useState<Open | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const openPlayback = useCallback((index: number, entries: QueueItem[], tracks: Track[]) => setOpen({ kind: "playback", index, entries, tracks }), []);
  const openEdit = useCallback((track: Track) => setOpen({ kind: "edit", track }), []);

  let menus: ReactNode = null;
  if (open?.kind === "playback") {
    const { index, entries, tracks } = open;
    const track = tracks[index];
    // Like desktop, adding to an empty queue starts it.
    const enqueue = (next: boolean) => run(() => changeQueue(queue => enqueueEntries(queue, [entries[index]], [track], next), !view?.queue.current), next ? "Playing next" : "Added to queue");
    const actions: MenuAction[] = [
      { label: "Standalone Play", icon: "play", run: () => run(() => changeQueue(queue => playEntries(queue, [entries[index]], [track]), true)) },
      { label: "Play from Here", icon: "skip", run: () => run(() => changeQueue(queue => playEntries(queue, entries.slice(index), tracks), true)) },
      { label: "Play Next", icon: "playNext", run: () => enqueue(true) },
      { label: "Add to Queue", icon: "addToQueue", run: () => enqueue(false) },
    ];
    menus = <Menu track={track} actions={actions} onClose={close} onVisibilityChange={onMenuVisibilityChange} />;
  } else if (open?.kind === "edit") {
    const { track } = open;
    const offline = offlineActive();
    const streaming = isDownloadable(track.globalId);
    const actions: MenuAction[] = [
      ...(remove && !offline ? [{ label: remove.label, icon: "remove" as const, run: () => run(() => remove.run(track), undefined, false) }] : []),
      ...(!offline && streaming && !inLibrary(track.globalId) ? [{ label: "Add to Library", icon: "add" as const, run: () => run(() => addToLibrary(track), "Added to library", false) }] : []),
      ...(!offline ? [{ label: "Add to Playlist", icon: "playlistAdd" as const, run: () => setTimeout(() => setOpen({ kind: "playlist", track }), 220) }] : []),
      ...(!offline && streaming ? [{ label: "Download", icon: "download" as const, run: () => setTimeout(() => openDownloadSheet([track], track.name), 220) }] : []),
      ...(onPhone(track.globalId) ? [{ label: "Remove Download", icon: "remove" as const, run: () => run(() => removePhoneDownloads([track.globalId]), "Removed from this phone", false) }] : []),
      ...(!offline && onServer(track.globalId) ? [{ label: "Remove from Server Downloads", icon: "remove" as const, run: () => run(() => removeServerDownloads([track.globalId]), "Removed from the server", false) }] : []),
      ...(!offline && streaming && track.albumId ? [{ label: "Go to Album", icon: "album" as const, run: () => push({ kind: "album", album: albumForTrack(track) }) }] : []),
      ...(!offline && streaming && track.artists[0]?.providerId ? [{ label: "Go to Artist", icon: "more" as const, run: () => push({ kind: "artist", artist: artistForTrack(track) }) }] : []),
      ...(!offline && streaming ? [{ label: "Credits", icon: "credits" as const, run: () => setTimeout(() => setOpen({ kind: "credits", track }), 220) }] : []),
    ];
    menus = <Menu track={track} actions={actions} onClose={() => setOpen(current => current?.kind === "edit" ? null : current)} onVisibilityChange={onMenuVisibilityChange} />;
  } else if (open?.kind === "playlist") {
    menus = <PlaylistPicker tracks={[open.track]} onClose={close} />;
  } else if (open?.kind === "credits") {
    menus = <CreditsSheet track={open.track} onClose={close} />;
  }
  return { openPlayback, openEdit, menus };
}
