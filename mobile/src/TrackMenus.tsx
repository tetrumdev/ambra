import { useCallback, type ReactNode } from "react";
import type { Track } from "../../desktop/src/types/music";
import { albumForTrack, artistForTrack } from "../../desktop/src/utils/browse";
import { changeQueue, offlineActive, sessionView, type QueueItem } from "./client";
import { isDownloadable, onPhone, onServer, removePhoneDownloads, removeServerDownloads } from "./downloads";
import { addToLibrary, inLibrary } from "./library";
import { useNavigation, useRun, type Route } from "./navigation";
import { enqueueEntries, playEntries } from "./queueModel";
import { openMenu, type MenuAction } from "./shell/ContextMenu";
import { openCredits, openDownloadSheet, openPlaylistPicker } from "./Sheets";
import type { Anchor, Frame } from "./Touchable";

export type { MenuAction };
/** Where the song is listed, for the edit menu's Remove action ("Remove from Playlist"…). */
export type RemoveAction = { label: string; run: (track: Track) => Promise<unknown> };
export type Run = (work: () => Promise<unknown>, done?: string, needsOutput?: boolean) => void;

/** Desktop's playback menu (TrackPlaybackMenu): what holding a song offers. */
export function playbackActions(index: number, entries: QueueItem[], tracks: Track[], run: Run, queueEmpty: boolean): MenuAction[] {
  const track = tracks[index];
  // Like desktop, adding to an empty queue starts it.
  const enqueue = (next: boolean) => run(() => changeQueue(queue => enqueueEntries(queue, [entries[index]], [track], next), queueEmpty), next ? "Playing next" : "Added to queue");
  return [
    { label: "Play Next", icon: "playNext", run: () => enqueue(true) },
    { label: "Add to Queue", icon: "addToQueue", run: () => enqueue(false) },
    { label: "Play from Here", icon: "skip", run: () => run(() => changeQueue(queue => playEntries(queue, entries.slice(index), tracks), true)) },
    { label: "Standalone Play", icon: "play", run: () => run(() => changeQueue(queue => playEntries(queue, [entries[index]], [track]), true)) },
  ];
}

/** Desktop's edit menu (TrackCollectionMenu, with Download). */
export function editActions(track: Track, push: (route: Route) => void, run: Run, remove?: RemoveAction): MenuAction[] {
  const offline = offlineActive();
  const streaming = isDownloadable(track.globalId);
  return [
    ...(!offline && streaming && !inLibrary(track.globalId) ? [{ label: "Add to Library", icon: "add" as const, run: () => run(() => addToLibrary(track), "Added to library", false) }] : []),
    ...(!offline ? [{ label: "Add to Playlist", icon: "playlistAdd" as const, run: () => openPlaylistPicker([track]) }] : []),
    ...(!offline && streaming && track.albumId ? [{ label: "Go to Album", icon: "album" as const, run: () => push({ kind: "album", album: albumForTrack(track) }) }] : []),
    ...(!offline && streaming && track.artists[0]?.providerId ? [{ label: "Go to Artist", icon: "artist" as const, run: () => push({ kind: "artist", artist: artistForTrack(track) }) }] : []),
    ...(!offline && streaming ? [{ label: "Download", icon: "download" as const, run: () => openDownloadSheet([track], track.name) }] : []),
    ...(!offline && streaming ? [{ label: "Credits", icon: "credits" as const, run: () => openCredits(track) }] : []),
    ...(onPhone(track.globalId) ? [{ label: "Remove Download", icon: "remove" as const, destructive: true, run: () => run(() => removePhoneDownloads([track.globalId]), "Removed from this phone", false) }] : []),
    ...(!offline && onServer(track.globalId) ? [{ label: "Remove from Server Downloads", icon: "remove" as const, destructive: true, run: () => run(() => removeServerDownloads([track.globalId]), "Removed from the server", false) }] : []),
    ...(remove && !offline ? [{ label: remove.label, icon: "remove" as const, destructive: true, run: () => run(() => remove.run(track), undefined, false) }] : []),
  ];
}

/**
 * Desktop's two song menus, opened where the finger is: holding a song offers playback, its
 * ⋯ button the edit menu.
 */
export function useTrackMenus(remove?: RemoveAction) {
  const { push } = useNavigation();
  const run = useRun();
  // Read when used, so the menus don't re-render with every session update.
  const queueEmpty = () => !sessionView()?.queue.current;
  const openPlayback = useCallback((index: number, entries: QueueItem[], tracks: Track[], anchor?: Anchor) =>
    openMenu({ anchor, track: tracks[index], actions: playbackActions(index, entries, tracks, run, queueEmpty()) }), [run]);
  const openEdit = useCallback((track: Track, anchor?: Anchor) =>
    openMenu({ anchor, track, actions: editActions(track, push, run, remove) }), [push, run, remove]);
  /**
   * The song's whole menu, as both holding a song and its ⋯ open it: playback first, then
   * editing. `row` is the song lifted above the dimmed screen at `frame`.
   */
  const openSong = useCallback((index: number, entries: QueueItem[], tracks: Track[], frame: Frame, row: ReactNode) => {
    const edits = editActions(tracks[index], push, run, remove);
    openMenu({ lifted: { frame, node: row }, actions: [
      ...playbackActions(index, entries, tracks, run, queueEmpty()),
      ...edits.map((action, at) => at === 0 ? { ...action, section: true } : action),
    ] });
  }, [push, run, remove]);
  /** Quick actions for a row's swipes. */
  const enqueue = useCallback((index: number, entries: QueueItem[], tracks: Track[], next: boolean) =>
    run(() => changeQueue(queue => enqueueEntries(queue, [entries[index]], [tracks[index]], next), queueEmpty()), next ? "Playing next" : "Added to queue"), [run]);
  return { openPlayback, openEdit, openSong, enqueue };
}
