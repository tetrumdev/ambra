import { useMemo, useState } from "react";
import type { GlobalTrackId, Track } from "../types/music";
import { useRangeSelection } from "../hooks/useRangeSelection";
import { ClickMenu } from "./ClickMenu";
import { DeleteMenu } from "./DeleteMenu";
import { SearchMenu } from "./SearchMenu";

type OpenMenu =
  | {
      kind: "track";
      trackId: GlobalTrackId;
      x: number;
      y: number;
    }
  | {
      kind: "delete";
      trackId: GlobalTrackId;
      x: number;
      y: number;
    };

type TrackListProps = {
  tracks: Track[];
  playTrack: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
  deleteTrack?: (trackId: GlobalTrackId) => void;
  deleteTracks?: (trackIds: GlobalTrackId[]) => void;
  addToLibrary?: (trackId: GlobalTrackId) => void;
};

function formatTime(time: number) {
  const totalSeconds = Math.max(0, Math.floor(time));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(Math.ceil(totalSeconds % 60)).padStart(2, "0");

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

export function TrackList({
  tracks,
  playTrack,
  playStandalone,
  addToQueue,
  playNext,
  deleteTrack,
  deleteTracks,
  addToLibrary,
}: TrackListProps) {
  const [hoveredTrackId, setHoveredTrackId] = useState<GlobalTrackId | null>(
    null,
  );
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const trackIds = useMemo(
    () => tracks.map((track) => track.globalId),
    [tracks],
  );
  const selection = useRangeSelection(trackIds);

  function selectTrack(event: React.MouseEvent, index: number) {
    event.preventDefault();
    event.stopPropagation();
    setOpenMenu(null);
    selection.toggle(index, event.shiftKey);
  }

  function handleTrackClick(event: React.MouseEvent, index: number) {
    if (selection.isSelecting) selectTrack(event, index);
  }

  function handleTrackContextMenu(event: React.MouseEvent, index: number) {
    if (!deleteTracks) return;
    selectTrack(event, index);
  }

  function deleteSelection() {
    if (!deleteTracks || selection.selectedIds.size === 0) return;
    deleteTracks([...selection.selectedIds]);
    selection.clear();
    setHoveredTrackId(null);
    setOpenMenu(null);
  }

  function showClickMenu(event: React.MouseEvent, trackId: GlobalTrackId) {
    const target = event.target as HTMLElement;
    const clickedRow = target === event.currentTarget;
    const clickedTrigger = target.closest("[data-click-menu-trigger]");

    if (!clickedRow && !clickedTrigger) return;

    setOpenMenu({
      kind: "track",
      trackId,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function showDeleteMenu(
    event: React.MouseEvent<HTMLDivElement>,
    trackId: GlobalTrackId,
  ) {
    event.stopPropagation();
    if (!deleteTrack && !addToLibrary) {
      setOpenMenu({
        kind: "track",
        trackId,
        x: event.clientX,
        y: event.clientY,
      });
      return;
    }

    const triggerRect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 180;
    const menuHeight = 55;
    const gap = 4;
    const fitsBelow =
      triggerRect.bottom + gap + menuHeight <= window.innerHeight;

    setOpenMenu({
      kind: "delete",
      trackId,
      x: triggerRect.right - menuWidth,
      y: fitsBelow
        ? triggerRect.bottom + gap
        : triggerRect.top - menuHeight - gap,
    });
  }

  return (
    <>
      {openMenu?.kind === "track" && (
        <ClickMenu
          hideClickMenu={() => setOpenMenu(null)}
          xPos={openMenu.x}
          yPos={openMenu.y}
          trackId={openMenu.trackId}
          playTrack={playTrack}
          playStandalone={playStandalone}
          addToQueue={addToQueue}
          playNext={playNext}
        />
      )}
      {openMenu?.kind === "delete" && deleteTrack && (
        <DeleteMenu
          hideDeleteMenu={() => setOpenMenu(null)}
          xPos={openMenu.x}
          yPos={openMenu.y}
          trackId={openMenu.trackId}
          deleteTrack={deleteTrack}
        />
      )}
      {openMenu?.kind === "delete" && addToLibrary && (
        <SearchMenu
          hideSearchMenu={() => setOpenMenu(null)}
          xPos={openMenu.x}
          yPos={openMenu.y}
          trackId={openMenu.trackId}
          addToLibrary={addToLibrary}
        />
      )}
      <div className="columnInfo">
        <span className="trackColumn">Track</span>
        <span className="artistColumn">Artist</span>
        <span className="albumColumn">Album</span>
        <span className="durationColumn">Duration</span>
        {selection.isSelecting && (
          <button
            className="selectionDeleteButton"
            type="button"
            disabled={selection.selectedIds.size === 0}
            onClick={deleteSelection}
          >
            Delete from library
          </button>
        )}
      </div>
      {tracks.map((track, index) => (
        <div
          className="libraryItem"
          key={track.globalId}
          data-selected={
            selection.selectedIds.has(track.globalId) ? "true" : undefined
          }
          data-selecting={selection.isSelecting ? "true" : undefined}
          data-menu-open={
            openMenu?.trackId === track.globalId ? "true" : undefined
          }
          onClickCapture={(event) => handleTrackClick(event, index)}
          onClick={(event) => showClickMenu(event, track.globalId)}
          onContextMenu={(event) => handleTrackContextMenu(event, index)}
        >
          <div
            className="coverImgContainer"
            onMouseEnter={() => setHoveredTrackId(track.globalId)}
            onMouseLeave={() => setHoveredTrackId(null)}
          >
            <img
              src="/Play.svg"
              alt=""
              aria-hidden="true"
              className="coverPlayBtn"
              data-variant={
                hoveredTrackId === track.globalId ? "btnEnabled" : "btnDisabled"
              }
            />
            <img
              src={track.cover}
              alt={`${track.album} album cover`}
              className="coverImg"
              onClick={() => playTrack(track.globalId)}
            />
          </div>
          <span className="trackName trackDescriptor" data-click-menu-trigger>
            {track.name}
          </span>
          <span className="artistName trackDescriptor">{track.artist}</span>
          <span className="albumName trackDescriptor">{track.album}</span>
          <span
            className="trackDuration trackDescriptor"
            data-click-menu-trigger
          >
            {formatTime(track.durationSeconds)}
          </span>
          <div
            className="libraryItemMenuContainer"
            onClick={(event) => showDeleteMenu(event, track.globalId)}
          >
            <img
              src={
                selection.isSelecting
                  ? selection.selectedIds.has(track.globalId)
                    ? "/select.svg"
                    : "/noSelect.svg"
                  : "/menu.svg"
              }
              alt={selection.isSelecting ? "Selection status" : "Menu"}
              className={selection.isSelecting ? "selectionIndicator" : undefined}
            />
          </div>
        </div>
      ))}
    </>
  );
}
