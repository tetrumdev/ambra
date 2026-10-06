import { albumForTrack, artistForTrack, type BrowseEntity } from "../utils/browse";
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
import { VirtualSpacer } from "./VirtualSpacer";
import { PerfProfiler } from "./PerfProfiler";
import { useVirtualWindow } from "../hooks/useVirtualWindow";
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
  onOpenEntity?: (entity: BrowseEntity) => void;
  savedTrackIds?: ReadonlySet<string>;
  showTrackNumbers?: boolean;
  showArtwork?: boolean;
  showRank?: boolean;
  playTrack: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
  removeTracks?: (trackIds: GlobalTrackId[]) => void;
  removalLabel?: string;
  playlistOptions?: PlaylistMenuOptions;
  addToLibrary?: (trackId: GlobalTrackId) => void;
  showProviderIcon?: boolean;
  reorderTracks?: (orderedTrackIds: GlobalTrackId[]) => void;
  sort?: TrackSort;
  onSortChange?: (sort: TrackSort) => void;
};

// Collections longer than this render only the rows near the viewport. Shorter
// ones (most playlists and albums) render in full, exactly as before.
const VIRTUALIZE_AFTER_ROWS = 120;

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
  onOpenEntity, savedTrackIds, showTrackNumbers = false, showRank = false, showArtwork = true,
  playTrack,
  playStandalone,
  addToQueue,
  playNext,
  removeTracks,
  removalLabel = "Remove from collection",
  addToLibrary,
  playlistOptions,
  showProviderIcon = false,
  reorderTracks,
  sort = null,
  onSortChange,
}: TrackListProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const showDiscNumbers = useMemo(() => tracks.some(track => (track.discNumber ?? 1) > 1), [tracks]);
  const entityActions = useRef(onOpenEntity);
  entityActions.current = onOpenEntity;
  const openEntity = useCallback((entity: BrowseEntity) => entityActions.current?.(entity), []);
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

  const columnHeaderRef = useRef<HTMLDivElement>(null);
  const draggedIndex = useMemo(
    () => (draggedTrackId === null ? null : trackIds.indexOf(draggedTrackId)),
    [draggedTrackId, trackIds],
  );
  const virtual = useVirtualWindow({
    count: tracks.length,
    enabled: tracks.length > VIRTUALIZE_AFTER_ROWS,
    probeRef: columnHeaderRef,
    probeIsContainer: false,
    fallback: { rowHeight: 76 },
    cacheKey: "track-list",
    overscanRows: 10,
    pinnedIndex: draggedIndex,
  });

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
        data-tooltip={nextLabel}
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
    <PerfProfiler id="track-list">
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
            ...(addToLibrary && !savedTrackIds?.has(openMenu.trackId) ? [{
              label: "Add to Library",
              onSelect: () => addToLibrary(openMenu.trackId),
            }] : []),
          ]}
        />
      )}
      {selection.isSelecting && (
        <div className="selectionActionMenu" role="group" aria-label="Selected tracks">
          <button
            className="selectionRemoveAction"
            type="button"
            disabled={selection.selectedIds.size === 0}
            aria-label={removalLabel}
            data-tooltip={removalLabel}
            onClick={removeSelection}
          >
            Remove
          </button>
          <button type="button" onClick={selection.clear}>
            Cancel
          </button>
        </div>
      )}
      <div className="columnInfo" ref={columnHeaderRef}>
        {columnHeader("track", "Track", "trackColumn")}
        {columnHeader("artist", "Artist", "artistColumn")}
        {columnHeader("album", "Album", "albumColumn")}
        {columnHeader("duration", "Duration", "durationColumn")}
      </div>
      {virtual.topSpace > 0 && <VirtualSpacer position="top" height={virtual.topSpace} />}
      {tracks.slice(virtual.start, virtual.end).map((track, windowIndex) => {
        const index = virtual.start + windowIndex;
        return (
          <TrackRow key={track.globalId} track={track} index={index}
            onOpenEntity={onOpenEntity ? openEntity : undefined} saved={savedTrackIds?.has(track.globalId)} showTrackNumbers={showTrackNumbers} showRank={showRank} showDiscNumbers={showDiscNumbers} showArtwork={showArtwork}
            selected={selection.selectedIds.has(track.globalId)}
            selecting={selection.isSelecting}
            menuOpen={openMenu?.trackId === track.globalId}
            collectionMenuOpen={openMenu?.trackId === track.globalId && openMenu.kind === "collection"}
            showProviderIcon={showProviderIcon}
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
        );
      })}
      {virtual.bottomSpace > 0 && <VirtualSpacer position="bottom" height={virtual.bottomSpace} />}
    </>
    </PerfProfiler>
  );
}

type RowAction = "select" | "playback" | "context" | "collection" | "play" | "warm" | "cancelWarm";
const TrackRow = memo(function TrackRow({ track, index, onOpenEntity, saved, showTrackNumbers, showRank, showDiscNumbers, showArtwork, selected, selecting, menuOpen, collectionMenuOpen, showProviderIcon, reorderable, dragging, dropPosition, onAction, onPointerDown }: {
  track: Track;
  index: number;
  onOpenEntity?: (entity: BrowseEntity) => void;
  saved?: boolean;
  showTrackNumbers: boolean;
  showRank: boolean;
  showDiscNumbers: boolean;
  showArtwork: boolean;
  selected: boolean;
  selecting: boolean;
  menuOpen: boolean;
  collectionMenuOpen: boolean;
  showProviderIcon: boolean;
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
      data-virtual-item=""
      draggable={false}
      onClickCapture={(event) => onAction("select", event, index)}
      onClick={(event) => onAction("playback", event, index)}
      onContextMenu={(event) => onAction("context", event, index)}
      onPointerDown={(event) => onPointerDown(event, index)}
      onDragStart={(event) => event.preventDefault()}
    >
      <div className="trackLeading">
        <button type="button" className="trackPlayButton" aria-label={`Play ${track.name}`}
          onClick={event => { event.stopPropagation(); onAction("play", event, index); }}
          onMouseEnter={event => onAction("warm", event, index)}
          onMouseLeave={event => onAction("cancelWarm", event, index)}>
          <img src="/Play.svg" alt="" aria-hidden="true" />
        </button>
        {showArtwork && <div className="coverImgContainer" data-playback-menu-trigger>
          <TrackArtwork track={track} alt={`${track.album} album cover`} className="coverImg" draggable={false} />
        </div>}
      </div>
      <span
        className={`trackName trackDescriptor${showProviderIcon ? " trackNameWithProvider" : ""}`}
        data-playback-menu-trigger
      >
        <span className="trackTitleText">{(showRank || showTrackNumbers) && <small className="trackNumber">{showRank ? index + 1 : <>{showDiscNumbers ? `${track.discNumber ?? 1}.` : ""}{track.trackNumber ?? index + 1}</>}</small>}{track.name}{saved && <small className="savedTrackBadge">Saved</small>}</span>
        {showProviderIcon && (
          <img
            className="trackProviderIcon"
            data-provider={track.provider}
            src={track.provider === "local" ? "/ambra.svg" : `/${track.provider}Icon.svg`}
            alt={musicProviderName(track.provider)}
            data-tooltip={musicProviderName(track.provider)}
          />
        )}
      </span>
      <span className="artistName trackDescriptor">{onOpenEntity ? <button type="button" className="entityLink" onClick={event => { event.stopPropagation(); onOpenEntity({ kind: "artist", artist: artistForTrack(track) }); }}>{track.artist}</button> : track.artist}</span>
      <span className="albumName trackDescriptor">{onOpenEntity ? <button type="button" className="entityLink" onClick={event => { event.stopPropagation(); onOpenEntity({ kind: "album", album: albumForTrack(track) }); }}>{track.album}</button> : track.album}</span>
      <span
        className="trackDuration trackDescriptor"
        data-playback-menu-trigger
      >
        {formatTime(track.durationSeconds)}
      </span>
      <button
        type="button"
        className="trackCollectionMenuTrigger"
        aria-label={`${selecting ? selected ? "Deselect" : "Select" : "Actions for"} ${track.name}`}
        aria-expanded={selecting ? undefined : collectionMenuOpen}
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
      </button>
    </div>
  );
});
