import { albumForTrack, type BrowseEntity } from "../utils/browse";
import { isTrackAvailable, useServiceAvailability } from "../hooks/useServiceAvailability";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { coreView, subscribeCore, warmCoreTrack } from "../api/core";
import { ProviderIcon } from "./ProviderIcon";
import type { GlobalTrackId, Track } from "../types/music";
import { useRangeSelection } from "../hooks/useRangeSelection";
import { useTrackReorder, type ReorderRules } from "../hooks/useTrackReorder";
import { movePackaged, packageDrop, packageIndex } from "../utils/playlistPackages";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { TrackCollectionMenu, type PlaylistMenuOptions } from "./TrackCollectionMenu";
import { MENU_WIDTH } from "../utils/trackMenu";
import { showTrackCredits } from "../utils/trackCredits";
import { TrackArtwork } from "./TrackArtwork";
import { VirtualSpacer } from "./VirtualSpacer";
import { ArtistLinks } from "./ArtistLinks";
import { trackArtistNames } from "../utils/trackArtists";
import { PerfProfiler } from "./PerfProfiler";
import { TrackColumnHeader } from "./TrackColumnHeader";
import { TrackExtraCells } from "./TrackExtraCells";
import { useVirtualWindow } from "../hooks/useVirtualWindow";
import { usePageFilteredTracks } from "../hooks/usePageFilter";
import { revealListItem } from "../utils/revealListItem";
import {
  type DropPosition,
  type TrackSort,
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
      flipY: number;
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
  /** Songs bound to play together; shown joined, and moved as one by their first song. */
  packages?: GlobalTrackId[][];
  bindTracks?: (trackIds: GlobalTrackId[]) => void;
  unbindTracks?: (trackIds: GlobalTrackId[]) => void;
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
  tracks: allTracks,
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
  reorderTracks: reorderAllTracks,
  packages,
  bindTracks,
  unbindTracks,
  sort = null,
  onSortChange,
}: TrackListProps) {
  const connected = useServiceAvailability();
  const { shown: tracks, filtering, reveal } = usePageFilteredTracks(allTracks);
  // A filtered list hides songs, so reordering it can't say where they belong.
  const reorderTracks = filtering ? undefined : reorderAllTracks;
  // Ranks and fallback numbers keep counting the whole list while it is filtered.
  const positions = useMemo(
    () => filtering ? new Map(allTracks.map((track, index) => [track.globalId, index])) : null,
    [allTracks, filtering],
  );
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const showDiscNumbers = useMemo(() => tracks.some(track => (track.discNumber ?? 1) > 1), [tracks]);
  const entityActions = useRef(onOpenEntity);
  entityActions.current = onOpenEntity;
  const openEntity = useCallback((entity: BrowseEntity) => entityActions.current?.(entity), []);
  const trackIds = useMemo(
    () => tracks.map((track) => track.globalId),
    [tracks],
  );
  const selectableIds = useMemo(() => tracks.filter(track => isTrackAvailable(track, connected)).map(track => track.globalId), [tracks, connected]);
  const selection = useRangeSelection(selectableIds);
  useEffect(() => { selection.clear(); setOpenMenu(null); }, [connected]);
  // Only the packaged songs this list shows; a song missing from it can't hold a package open.
  const shownPackages = useMemo(() => {
    const shown = new Set(trackIds);
    return (packages ?? []).map(pack => pack.filter(id => shown.has(id))).filter(pack => pack.length >= 2);
  }, [packages, trackIds]);
  const packed = useMemo(() => packageIndex(shownPackages), [shownPackages]);
  const reorderRules = useMemo<ReorderRules | undefined>(() => shownPackages.length ? {
    resolve: (sourceId, target) => packageDrop(shownPackages, sourceId, target),
    move: (ids, sourceId, target) => movePackaged(ids, shownPackages, sourceId, target),
  } : undefined, [shownPackages]);
  const firstTrack = tracks[0];
  const outputId = useSyncExternalStore(subscribeCore, () => coreView()?.output?.endpointId);
  useEffect(() => {
    if (!firstTrack || !isTrackAvailable(firstTrack, connected)) return;
    void warmCoreTrack(firstTrack).catch(() => {});
  }, [firstTrack, connected, outputId]);
  const warmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(warmTimer.current), []);
  const { draggedTrackId, dropTarget, suppressClick, onPointerDown } = useTrackReorder(
    trackIds,
    reorderTracks,
    () => {
      setOpenMenu(null);
      clearTimeout(warmTimer.current);
    },
    undefined,
    undefined,
    reorderRules,
  );
  // A package's first song carries the whole package.
  const draggedPackage = draggedTrackId !== null && packed.get(draggedTrackId)?.[0] === draggedTrackId
    ? packed.get(draggedTrackId)!
    : null;

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
  // The page's only match stays among its neighbours; the list jumps to it once per find.
  const revealIndex = reveal.target ? tracks.findIndex(track => track.globalId === reveal.target) : -1;
  useLayoutEffect(() => {
    const list = columnHeaderRef.current?.parentElement;
    if (reveal.key && revealIndex >= 0 && list) revealListItem(list, revealIndex, virtual.start);
  }, [reveal.key]);

  function selectTrack(event: React.MouseEvent, index: number) {
    event.preventDefault();
    event.stopPropagation();
    setOpenMenu(null);
    selection.toggle(selectableIds.indexOf(tracks[index].globalId), event.shiftKey);
  }

  function handleTrackClick(event: React.MouseEvent, index: number) {
    if (selection.isSelecting) selectTrack(event, index);
  }

  function handleTrackContextMenu(event: React.MouseEvent, index: number) {
    if (!removeTracks) return;
    selectTrack(event, index);
  }

  const selectionPackaged = [...selection.selectedIds].some(id => packed.has(id));
  function bindSelection() {
    if (!bindTracks || selection.selectedIds.size < 2) return;
    bindTracks([...selection.selectedIds]);
    selection.clear();
  }
  function unbindSelection() {
    if (!unbindTracks || !selectionPackaged) return;
    unbindTracks([...selection.selectedIds]);
    selection.clear();
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
    const menuWidth = MENU_WIDTH;
    const gap = 4;

    setOpenMenu({
      kind: "collection",
      trackId,
      x: triggerRect.right - menuWidth,
      y: triggerRect.bottom + gap,
      flipY: triggerRect.top - gap,
    });
  }

  // Stable event entry point lets playback clock updates skip every unchanged row.
  const actions = useRef<(action: RowAction, event: React.MouseEvent<HTMLDivElement>, index: number) => void>(() => {});
  actions.current = (action, event, index) => {
    const track = tracks[index];
    if (!track) return;
    if (!isTrackAvailable(track, connected) && action !== "collection") return;
    if (!isTrackAvailable(track, connected) && !removeTracks) return;
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
        warmTimer.current = setTimeout(() => {
          void warmCoreTrack(track).catch(() => {});
        }, 100);
        break;
    }
  };
  const onRowAction = useCallback((action: RowAction, event: React.MouseEvent, index: number) => {
    actions.current(action, event as React.MouseEvent<HTMLDivElement>, index);
  }, []);

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
          flipY={openMenu.flipY}
          actions={[
            ...(removeTracks ? [{
              label: removalLabel,
              icon: "/delete.svg",
              whenUnavailable: true,
              onSelect: () => removeTracks([openMenu.trackId]),
            }] : []),
            ...(addToLibrary && !savedTrackIds?.has(openMenu.trackId) ? [{
              label: "Add to Library",
              icon: "/add.svg",
              onSelect: () => addToLibrary(openMenu.trackId),
            }] : []),
            { label: "Credits", icon: "/credits.svg", onSelect: () => showTrackCredits(tracks.find(track => track.globalId === openMenu.trackId) ?? null) },
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
          {bindTracks && (
            <button type="button" disabled={selection.selectedIds.size < 2} onClick={bindSelection}
              data-tooltip="Always play these songs together, in order, even when shuffled">
              Bind
            </button>
          )}
          {unbindTracks && selectionPackaged && (
            <button type="button" onClick={unbindSelection}>
              Unbind
            </button>
          )}
          <button type="button" onClick={selection.clear}>
            Cancel
          </button>
        </div>
      )}
      <TrackColumnHeader headerRef={columnHeaderRef} sort={sort} onSortChange={onSortChange} />
      {virtual.topSpace > 0 && <VirtualSpacer position="top" height={virtual.topSpace} />}
      {tracks.slice(virtual.start, virtual.end).map((track, windowIndex) => {
        const index = virtual.start + windowIndex;
        const pack = packed.get(track.globalId);
        return (
          <TrackRow key={track.globalId} track={track} index={index} position={positions?.get(track.globalId) ?? index}
            available={isTrackAvailable(track, connected)} removable={Boolean(removeTracks)}
            onOpenEntity={onOpenEntity && isTrackAvailable(track, connected) ? openEntity : undefined} saved={savedTrackIds?.has(track.globalId)} showTrackNumbers={showTrackNumbers} showRank={showRank} showDiscNumbers={showDiscNumbers} showArtwork={showArtwork}
            selected={selection.selectedIds.has(track.globalId)}
            selecting={selection.isSelecting && isTrackAvailable(track, connected)}
            menuOpen={openMenu?.trackId === track.globalId}
            collectionMenuOpen={openMenu?.trackId === track.globalId && openMenu.kind === "collection"}
            showProviderIcon={showProviderIcon}
            reorderable={Boolean(reorderTracks) && isTrackAvailable(track, connected)}
            dragging={draggedTrackId === track.globalId || Boolean(draggedPackage?.includes(track.globalId))}
            packageIndex={pack?.indexOf(track.globalId)}
            packageSize={pack?.length}
            dropPosition={
              dropTarget?.trackId === track.globalId
                ? dropTarget.position
                : null
            }
            revealed={reveal.breathing && reveal.target === track.globalId}
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
const TrackRow = memo(function TrackRow({ track, index, position, available, removable, onOpenEntity, saved, showTrackNumbers, showRank, showDiscNumbers, showArtwork, selected, selecting, menuOpen, collectionMenuOpen, showProviderIcon, reorderable, dragging, packageIndex, packageSize, dropPosition, revealed, onAction, onPointerDown }: {
  track: Track;
  available: boolean;
  removable: boolean;
  index: number;
  /** Where the song sits in the whole, unfiltered list. */
  position: number;
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
  /** Position within its package, when the song is bound to others. */
  packageIndex?: number;
  packageSize?: number;
  dropPosition: DropPosition | null;
  /** The filter's only match, breathing until the listener does anything. */
  revealed: boolean;
  onAction: (action: RowAction, event: React.MouseEvent, index: number) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>, index: number) => void;
}) {
  return (
    <div
      className="libraryItem"
      data-unavailable={!available ? "true" : undefined}
      data-selected={
        selected ? "true" : undefined
      }
      data-selecting={selecting ? "true" : undefined}
      data-menu-open={
        menuOpen ? "true" : undefined
      }
      data-reorderable={reorderable ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-package={packageIndex === undefined || packageSize === undefined ? undefined
        : packageIndex === 0 ? "first" : packageIndex === packageSize - 1 ? "last" : "middle"}
      data-drop-position={dropPosition ?? undefined}
      data-revealed={revealed ? "true" : undefined}
      data-track-id={track.globalId}
      data-virtual-item=""
      draggable={false}
      onClickCapture={(event) => onAction("select", event, index)}
      onClick={(event) => onAction("playback", event, index)}
      onContextMenu={(event) => onAction("context", event, index)}
      onPointerDown={available ? (event) => onPointerDown(event, index) : undefined}
      onDragStart={(event) => event.preventDefault()}
    >
      <div className="trackLeading" inert={!available}>
        <button type="button" className="trackPlayButton" aria-label={`Play ${track.name}`}
          disabled={!available}
          onClick={event => { event.stopPropagation(); onAction("play", event, index); }}
          onMouseEnter={event => onAction("warm", event, index)}
          onMouseLeave={event => onAction("cancelWarm", event, index)}>
          <img src="/play.svg" alt="" aria-hidden="true" />
        </button>
        {showArtwork && <div className="coverImgContainer" data-playback-menu-trigger>
          <TrackArtwork track={track} alt={`${track.album} album cover`} className="coverImg" draggable={false} />
        </div>}
      </div>
      <span
        className={`trackName trackDescriptor${showProviderIcon ? " trackNameWithProvider" : ""}`}
        data-playback-menu-trigger
      >
        <span className="trackTitleText">{(showRank || showTrackNumbers) && <small className="trackNumber">{showRank ? position + 1 : <>{showDiscNumbers ? `${track.discNumber ?? 1}.` : ""}{track.trackNumber ?? position + 1}</>}</small>}{track.name}{saved && <small className="savedTrackBadge">Saved</small>}</span>
        {showProviderIcon && (
          <ProviderIcon provider={track.provider} />
        )}
      </span>
      <span className="artistName trackDescriptor">{onOpenEntity ? <ArtistLinks track={track} onOpenEntity={onOpenEntity} /> : trackArtistNames(track)}</span>
      <span className="albumName trackDescriptor">{onOpenEntity ? <button type="button" className="entityLink" onClick={event => { event.stopPropagation(); onOpenEntity({ kind: "album", album: albumForTrack(track) }); }}>{track.album}</button> : track.album}</span>
      <TrackExtraCells track={track} />
      <span
        className="trackDuration trackDescriptor"
        data-playback-menu-trigger
      >
        {formatTime(track.durationSeconds)}
      </span>
      <button
        type="button"
        className="trackCollectionMenuTrigger"
        disabled={!available && !removable}
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
                : "/no-select.svg"
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
