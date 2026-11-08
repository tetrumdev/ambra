import { createPortal } from "react-dom";
import type { Track } from "../types/music";
import { TrackCollectionMenu, type PlaylistMenuOptions, type TrackCollectionAction } from "./TrackCollectionMenu";
import type { EntityAction } from "./EntityView";
import { isDownloadable, openDownloadDialog } from "../utils/offlineDownloads";

export type AlbumMenuProps = {
  title: string;
  /** The album's songs; null while they load. */
  tracks: Track[] | null;
  savedTrackIds: ReadonlySet<string>;
  onAction: (action: EntityAction, tracks: Track[]) => void;
  onAddTracks: (tracks: Track[]) => void;
  playlistOptions?: PlaylistMenuOptions;
  xPos: number;
  yPos: number;
  flipY?: number;
  onClose: () => void;
};

/** An album's library menu: the same actions a song's has, for every song on it. */
export function AlbumMenu({ title, tracks, savedTrackIds, onAction, onAddTracks, playlistOptions, xPos, yPos, flipY, onClose }: AlbumMenuProps) {
  const songs = tracks ?? [];
  const unsaved = songs.filter(track => !savedTrackIds.has(track.globalId) && track.provider !== "local");
  const downloads = songs.map(track => track.globalId).filter(isDownloadable);
  const loading = tracks === null;
  const actions: TrackCollectionAction[] = [
    { label: "Add to Queue", icon: "/add-to-queue.svg", disabled: !songs.length, onSelect: () => onAction("queue", songs) },
    { label: "Play Next", icon: "/play-next.svg", disabled: !songs.length, onSelect: () => onAction("nextAll", songs) },
    {
      label: loading ? "Loading songs…" : unsaved.length || !songs.length ? "Add to Library" : "In Library",
      icon: "/add.svg",
      disabled: !unsaved.length,
      onSelect: () => onAddTracks(unsaved),
    },
    ...(downloads.length ? [{ label: "Download", icon: "/download.svg", onSelect: () => openDownloadDialog(downloads, title) }] : []),
  ];
  // Portaled, so a clipped header or a scrolling grid can't trap the fixed menu.
  return createPortal(
    <TrackCollectionMenu
      trackId=""
      tracks={tracks}
      playlistOptions={playlistOptions}
      xPos={xPos}
      yPos={yPos}
      flipY={flipY}
      onClose={onClose}
      actions={actions}
    />,
    document.body,
  );
}
