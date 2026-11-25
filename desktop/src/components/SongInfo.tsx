import { useContext, useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { albumForTrack, type BrowseEntity } from "../utils/browse";
import { ArtistLinks } from "./ArtistLinks";
import { TrackTitleLink } from "./TrackTitleLink";
import { MenuDotsIcon } from "./MenuDotsIcon";
import { TrackCollectionMenu, type PlaylistMenuOptions, type TrackCollectionAction } from "./TrackCollectionMenu";
import type { Track } from "../types/music";
import "./SongInfo.css";
import { showTrackCredits } from "../utils/trackCredits";
import { isTrackAvailable, useServiceAvailability } from "../hooks/useServiceAvailability";
import { SongContextMenu, pauseTrackAction, playSongOnDoubleClick, songMenuPosition, suppressSongClick } from "../utils/trackMenu";
import { useNowPlaying } from "../hooks/useNowPlaying";

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
  const connected = useServiceAvailability();
  const combinedMenu = useContext(SongContextMenu);
  const nowPlaying = useNowPlaying();
  const available = !track || isTrackAvailable(track, connected);
  const [position, setPosition] = useState<{
    x: number; y: number; flipY?: number; placement?: "above"; returnFocusTo?: HTMLElement; instant?: boolean;
  } | null>(null);
  // The menu belongs to the song it was opened for.
  useEffect(() => setPosition(null), [track?.globalId, combinedMenu]);
  const openCombinedMenu = combinedMenu && track && menu && available
    ? (event: MouseEvent<HTMLElement>) => setPosition(songMenuPosition(event))
    : undefined;
  // The compact bar hides the album name, so the menu offers it; the expanded bar shows
  // both album and artist links, so it needs neither.
  const actions: TrackCollectionAction[] = track && menu ? [
    ...(combinedMenu && nowPlaying.trackId === track.globalId && nowPlaying.isPlaying ? [pauseTrackAction(nowPlaying.togglePlayback)] : []),
    ...(!menu.inLibrary && track.provider !== "local"
      ? [{ label: "Add to Library", icon: "/add.svg", onSelect: () => menu.onAddToLibrary(track) }]
      : []),
    ...(!combinedMenu ? [
      ...(menu.showAlbumLink ? [{ label: "Go to Album", icon: "/album.svg", onSelect: () => onOpenEntity({ kind: "album", album: albumForTrack(track) }) }] : []),
      { label: "Credits", icon: "/credits.svg", onSelect: () => showTrackCredits(track) },
    ] : []),
  ] : [];
  return (
    <div id="songInfo" inert={!available} data-unavailable={!available ? "true" : undefined}>
      {/* Only as wide as the title and its menu button, so hovering the title is what shows the button. */}
      <div className="songNameRow" onClickCapture={combinedMenu ? suppressSongClick : undefined}
        onContextMenu={openCombinedMenu}
        onDoubleClick={combinedMenu && track && available && nowPlaying.trackId === track.globalId && !nowPlaying.isPlaying
          ? event => playSongOnDoubleClick(event, nowPlaying.togglePlayback) : undefined}>
        {track ? <TrackTitleLink id="songName" track={track} onOpenEntity={onOpenEntity} />
          : <span id="songName">Nothing Playing</span>}
        {available && track && menu && (
          <button
            type="button"
            className="songMenuButton"
            aria-label={`Library options for ${track.name}`}
            aria-haspopup="menu"
            aria-expanded={position !== null}
            onClick={openCombinedMenu ?? (event => {
              const rect = event.currentTarget.getBoundingClientRect();
              setPosition({ x: rect.left, y: rect.top - 6, placement: "above" });
            })}
          >
            <MenuDotsIcon />
          </button>
        )}
      </div>
      {track && menu && position && createPortal(
        <TrackCollectionMenu
          trackId={track.globalId}
          playlistOptions={menu.playlistOptions}
          actions={actions}
          xPos={position.x}
          yPos={position.y}
          flipY={position.flipY}
          placement={position.placement}
          returnFocusTo={position.returnFocusTo}
          instant={position.instant}
          onClose={() => setPosition(null)}
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
