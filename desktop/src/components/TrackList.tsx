import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { nativeAudioSource } from "../utils/nativeAudioSource";
import type { GlobalTrackId, Track } from "../types/music";
import { useRangeSelection } from "../hooks/useRangeSelection";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { TrackCollectionMenu, type PlaylistMenuOptions } from "./TrackCollectionMenu";
import { TrackArtwork } from "./TrackArtwork";

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
        <span className="trackColumn">Track</span>
        <span className="artistColumn">Artist</span>
        <span className="albumColumn">Album</span>
        <span className="durationColumn">Duration</span>
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
          onAction={onRowAction}
        />
      ))}
    </>
  );
}

type RowAction = "select" | "playback" | "context" | "collection" | "play" | "warm" | "cancelWarm";
const TrackRow = memo(function TrackRow({ track, index, selected, selecting, menuOpen, collectionMenuOpen, onAction }: {
  track: Track;
  index: number;
  selected: boolean;
  selecting: boolean;
  menuOpen: boolean;
  collectionMenuOpen: boolean;
  onAction: (action: RowAction, event: React.MouseEvent, index: number) => void;
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
      onClickCapture={(event) => onAction("select", event, index)}
      onClick={(event) => onAction("playback", event, index)}
      onContextMenu={(event) => onAction("context", event, index)}
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
          onClick={(event) => onAction("play", event, index)}
        />
      </div>
      <span className="trackName trackDescriptor" data-playback-menu-trigger>
        {track.name}
      </span>
      <span className="artistName trackDescriptor">{track.artist}</span>
      <span className="albumName trackDescriptor">{track.album}</span>
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
