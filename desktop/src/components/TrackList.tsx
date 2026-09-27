import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { nativeAudioSource } from "../utils/nativeAudioSource";
import { musicProviderName } from "../utils/musicProviderName";
import type { GlobalTrackId, Track } from "../types/music";
import { useRangeSelection } from "../hooks/useRangeSelection";
import { useTrackReorder } from "../hooks/useTrackReorder";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { TrackCollectionMenu, type PlaylistMenuOptions } from "./TrackCollectionMenu";
import { TrackArtwork } from "./TrackArtwork";
import {
  nextTrackSort,
  type DropPosition,
  type TrackSort,
  type TrackSortKey,
} from "../utils/trackCollectionOrder";

type OpenMenu =
  | {
      kind: "playback";
      trackId: GlobalTrackId;
      x: number;
      y: number;
    }
  | {
      kind: "collection";
      trackId: GlobalTrackId;
      x: number;
      y: number;
    };

export type TrackListProps = {
  tracks: Track[];
  playTrack: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
  removeTracks?: (trackIds: GlobalTrackId[]) => void;
  removalLabel?: string;
  playlistOptions?: PlaylistMenuOptions;
  addToLibrary?: (trackId: GlobalTrackId) => void;
  showServiceColumn?: boolean;
  reorderTracks?: (orderedTrackIds: GlobalTrackId[]) => void;
  sort?: TrackSort;
  onSortChange?: (sort: TrackSort) => void;
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
  removeTracks,
  removalLabel = "Remove from collection",
  addToLibrary,
  playlistOptions,
  showServiceColumn = false,
  reorderTracks,
  sort = null,
  onSortChange,
}: TrackListProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const trackIds = useMemo(
    () => tracks.map((track) => track.globalId),
    [tracks],
  );
  const selection = useRangeSelection(trackIds);
  const firstTrack = tracks[0];
  useEffect(() => {
    if (!isTauri() || !firstTrack) return;
    void invoke("warm_native_audio", { source: nativeAudioSource(firstTrack) })
      .catch(() => {});
  }, [firstTrack]);
  const warmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(warmTimer.current), []);
  const { draggedTrackId, dropTarget, suppressClick, onPointerDown } = useTrackReorder(
    trackIds,
    reorderTracks,
    () => {
      setOpenMenu(null);
      clearTimeout(warmTimer.current);
    },
  );

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
    if (!removeTracks) return;
    selectTrack(event, index);
  }

  function removeSelection() {
    if (!removeTracks || selection.selectedIds.size === 0) return;
    removeTracks([...selection.selectedIds]);
    selection.clear();
    setOpenMenu(null);
  }

  function showPlaybackMenu(event: React.MouseEvent, trackId: GlobalTrackId) {
    const target = event.target as HTMLElement;
    const clickedRow = target === event.currentTarget;
    const clickedTrigger = target.closest("[data-playback-menu-trigger]");

    if (!clickedRow && !clickedTrigger) return;

    setOpenMenu({
      kind: "playback",
      trackId,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function showCollectionMenu(
    event: React.MouseEvent<HTMLDivElement>,
    trackId: GlobalTrackId,
  ) {
    event.stopPropagation();
    if (!removeTracks && !addToLibrary && !playlistOptions) {
      setOpenMenu({
        kind: "playback",
        trackId,
        x: event.clientX,
        y: event.clientY,
      });
      return;
    }

    const triggerRect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 180;
    const gap = 4;

    setOpenMenu({
      kind: "collection",
      trackId,
      x: triggerRect.right - menuWidth,
      y: triggerRect.bottom + gap,
    });
  }

  // Stable event entry point lets playback clock updates skip every unchanged row.
  const actions = useRef<(action: RowAction, event: React.MouseEvent<HTMLDivElement>, index: number) => void>(() => {});
  actions.current = (action, event, index) => {
    const track = tracks[index];
    if (!track) return;
    if (
      suppressClick.current &&
      ["select", "playback", "collection", "play"].includes(action)
    ) {
      return;
    }
    switch (action) {
      case "select": handleTrackClick(event, index); break;
      case "playback": showPlaybackMenu(event, track.globalId); break;
      case "context": handleTrackContextMenu(event, index); break;
      case "collection": showCollectionMenu(event, track.globalId); break;
      case "play": playTrack(track.globalId); break;
      case "cancelWarm": clearTimeout(warmTimer.current); break;
      case "warm":
        clearTimeout(warmTimer.current);
        if (isTauri()) warmTimer.current = setTimeout(() => {
          void invoke("warm_native_audio", { source: nativeAudioSource(track) }).catch(() => {});
        }, 100);
        break;
    }
  };
  const onRowAction = useCallback((action: RowAction, event: React.MouseEvent, index: number) => {
    actions.current(action, event as React.MouseEvent<HTMLDivElement>, index);
  }, []);

  function columnHeader(
    key: TrackSortKey,
    label: string,
    className: string,
  ) {
    if (!onSortChange) return <span className={className}>{label}</span>;

    const direction = sort?.key === key ? sort.direction : null;
    const nextLabel =
      direction === "descending"
        ? `Sort ${label} ascending`
        : direction === "ascending"
          ? `Return to date-added order`
          : `Sort ${label} descending`;
    return (
      <button
        className={`${className} columnSortButton`}
        type="button"
        data-sort-direction={direction ?? undefined}
        aria-label={nextLabel}
        title={nextLabel}
        onClick={() => onSortChange(nextTrackSort(sort, key))}
      >
        <span>{label}</span>
        {direction && (
          <span className="columnSortIndicator" aria-hidden="true">
            {direction === "descending" ? "↓" : "↑"}
          </span>
        )}
      </button>
    );
  }

  return (
    <>
      {openMenu?.kind === "playback" && (
        <TrackPlaybackMenu
          onClose={() => setOpenMenu(null)}
          xPos={openMenu.x}
          yPos={openMenu.y}
          trackId={openMenu.trackId}
          playTrack={playTrack}
          playStandalone={playStandalone}
          addToQueue={addToQueue}
          playNext={playNext}
        />
      )}
      {openMenu?.kind === "collection" && (
        <TrackCollectionMenu
          trackId={openMenu.trackId}
          playlistOptions={playlistOptions}
          onClose={() => setOpenMenu(null)}
          xPos={openMenu.x}
          yPos={openMenu.y}
          actions={[
            ...(removeTracks ? [{
              label: removalLabel,
              onSelect: () => removeTracks([openMenu.trackId]),
            }] : []),
            ...(addToLibrary ? [{
              label: "Add to Library",
              onSelect: () => addToLibrary(openMenu.trackId),
            }] : []),
          ]}
        />
      )}
      <div className="columnInfo">
        {columnHeader("track", "Track", "trackColumn")}
        {columnHeader("artist", "Artist", "artistColumn")}
        {columnHeader("album", "Album", "albumColumn")}
        {showServiceColumn && <span className="serviceColumn">Service</span>}
        {columnHeader("duration", "Duration", "durationColumn")}
        {selection.isSelecting && (
          <button
            className="selectionDeleteButton"
            type="button"
            disabled={selection.selectedIds.size === 0}
            onClick={removeSelection}
          >
            {removalLabel}
          </button>
        )}
      </div>
      {tracks.map((track, index) => (
        <TrackRow key={track.globalId} track={track} index={index}
          selected={selection.selectedIds.has(track.globalId)}
          selecting={selection.isSelecting}
          menuOpen={openMenu?.trackId === track.globalId}
          collectionMenuOpen={openMenu?.trackId === track.globalId && openMenu.kind === "collection"}
          showServiceColumn={showServiceColumn}
          reorderable={Boolean(reorderTracks)}
          dragging={draggedTrackId === track.globalId}
          dropPosition={
            dropTarget?.trackId === track.globalId
              ? dropTarget.position
              : null
          }
          onAction={onRowAction}
          onPointerDown={onPointerDown}
        />
      ))}
    </>
  );
}

type RowAction = "select" | "playback" | "context" | "collection" | "play" | "warm" | "cancelWarm";
const TrackRow = memo(function TrackRow({ track, index, selected, selecting, menuOpen, collectionMenuOpen, showServiceColumn, reorderable, dragging, dropPosition, onAction, onPointerDown }: {
  track: Track;
  index: number;
  selected: boolean;
  selecting: boolean;
  menuOpen: boolean;
  collectionMenuOpen: boolean;
  showServiceColumn: boolean;
  reorderable: boolean;
  dragging: boolean;
  dropPosition: DropPosition | null;
  onAction: (action: RowAction, event: React.MouseEvent, index: number) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>, index: number) => void;
}) {
  return (
    <div
      className="libraryItem"
      data-selected={
        selected ? "true" : undefined
      }
      data-selecting={selecting ? "true" : undefined}
      data-menu-open={
        menuOpen ? "true" : undefined
      }
      data-reorderable={reorderable ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-drop-position={dropPosition ?? undefined}
      data-track-id={track.globalId}
      draggable={false}
      onClickCapture={(event) => onAction("select", event, index)}
      onClick={(event) => onAction("playback", event, index)}
      onContextMenu={(event) => onAction("context", event, index)}
      onPointerDown={(event) => onPointerDown(event, index)}
      onDragStart={(event) => event.preventDefault()}
    >
      <div
        className="coverImgContainer"
        onMouseEnter={(event) => onAction("warm", event, index)}
        onMouseLeave={(event) => onAction("cancelWarm", event, index)}
      >
        <img
          src="/Play.svg"
          alt=""
          aria-hidden="true"
          className="coverPlayBtn"
        />
        <TrackArtwork
          track={track}
          alt={`${track.album} album cover`}
          className="coverImg"
          draggable={false}
          onClick={(event) => onAction("play", event, index)}
        />
      </div>
      <span className="trackName trackDescriptor" data-playback-menu-trigger>
        {track.name}
      </span>
      <span className="artistName trackDescriptor">{track.artist}</span>
      <span className="albumName trackDescriptor">{track.album}</span>
      {showServiceColumn && (
        <span className="trackService trackDescriptor">{musicProviderName(track.provider)}</span>
      )}
      <span
        className="trackDuration trackDescriptor"
        data-playback-menu-trigger
      >
        {formatTime(track.durationSeconds)}
      </span>
      <div
        className="trackCollectionMenuTrigger"
        onClick={(event) => onAction("collection", event, index)}
        data-collection-menu-trigger
        data-collection-menu-open={collectionMenuOpen ? "true" : undefined}
      >
        <img
          src={
            selecting
              ? selected
                ? "/select.svg"
                : "/noSelect.svg"
              : "/menu.svg"
          }
          alt={selecting ? "Selection status" : "Menu"}
          className={
            selecting ? "selectionIndicator" : undefined
          }
        />
      </div>
    </div>
  );
});
