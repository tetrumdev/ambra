import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { albumForTrack, type BrowseEntity } from "../utils/browse";
import { ArtistLinks } from "./ArtistLinks";
import { TrackCollectionMenu, type PlaylistMenuOptions, type TrackCollectionAction } from "./TrackCollectionMenu";
import type { Track } from "../types/music";
import "./SongInfo.css";

type SongInfoProps = {
  track: Track | undefined;
  onOpenEntity: (entity: BrowseEntity) => void;
  /** The playing song's library menu; without it the title shows no menu button. */
  menu?: {
    playlistOptions: PlaylistMenuOptions;
    inLibrary: boolean;
    /** Off in the expanded bar, which already shows the album name as a link. */
    showAlbumLink: boolean;
    onAddToLibrary: (track: Track) => void;
  };
};

export function SongInfo({ track, onOpenEntity, menu }: SongInfoProps) {
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  // The menu belongs to the song it was opened for.
  useEffect(() => setMenuAnchor(null), [track?.globalId]);
  // The compact bar hides the album name, so the menu offers it; the expanded bar shows
  // both album and artist links, so it needs neither.
  const actions: TrackCollectionAction[] = track && menu ? [
    ...(!menu.inLibrary && track.provider !== "local"
      ? [{ label: "Add to Library", onSelect: () => menu.onAddToLibrary(track) }]
      : []),
    ...(menu.showAlbumLink
      ? [{ label: "Go to Album", onSelect: () => onOpenEntity({ kind: "album", album: albumForTrack(track) }) }]
      : []),
  ] : [];
  return (
    <div id="songInfo">
      {/* Only as wide as the title and its menu button, so hovering the title is what shows the button. */}
      <div className="songNameRow">
        <span id="songName" data-tooltip={track?.name} data-tooltip-overflow="">{track?.name ?? "Nothing Playing"}</span>
        {track && menu && (
          <button
            type="button"
            className="songMenuButton"
            aria-label={`Library options for ${track.name}`}
            aria-haspopup="menu"
            aria-expanded={menuAnchor !== null}
            onClick={(event) => setMenuAnchor(event.currentTarget.getBoundingClientRect())}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="4" cy="10" r="1.8" />
              <circle cx="10" cy="10" r="1.8" />
              <circle cx="16" cy="10" r="1.8" />
            </svg>
          </button>
        )}
      </div>
      {track && menu && menuAnchor && createPortal(
        <TrackCollectionMenu
          trackId={track.globalId}
          playlistOptions={menu.playlistOptions}
          actions={actions}
          xPos={menuAnchor.left}
          yPos={menuAnchor.top - 6}
          placement="above"
          onClose={() => setMenuAnchor(null)}
        />,
        document.body,
      )}
      {track && (
        <>
          <span id="albumName">
            <span className="label">On </span>
            <button type="button" className="entityLink value" onClick={() => onOpenEntity({ kind: "album", album: albumForTrack(track) })}>{track.album}</button>
          </span>
          <span id="artistName">
            <span className="label">Performed by </span>
            <ArtistLinks track={track} onOpenEntity={onOpenEntity} className="entityLink value" />
          </span>
        </>
      )}
    </div>
  );
}
