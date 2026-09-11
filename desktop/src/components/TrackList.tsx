import { useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { nativeAudioSource } from "../utils/nativeAudioSource";
import type { GlobalTrackId, Track } from "../types/music";
import { useRangeSelection } from "../hooks/useRangeSelection";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { TrackCollectionMenu, type PlaylistMenuOptions } from "./TrackCollectionMenu";

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
  const [hoveredTrackId, setHoveredTrackId] = useState<GlobalTrackId | null>(
    null,
  );
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
  const hoveredTrack = tracks.find(track => track.globalId === hoveredTrackId);
  useEffect(() => {
    if (!isTauri() || !hoveredTrack) return;
    const timer = window.setTimeout(() => {
      void invoke("warm_native_audio", { source: nativeAudioSource(hoveredTrack) })
        .catch(() => {});
    }, 100);
    return () => window.clearTimeout(timer);
  }, [hoveredTrack]);

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
    setHoveredTrackId(null);
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
          onClick={(event) => showPlaybackMenu(event, track.globalId)}
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
            onClick={(event) => showCollectionMenu(event, track.globalId)}
            data-collection-menu-trigger
            data-collection-menu-open={openMenu?.trackId === track.globalId && openMenu.kind === "collection" ? "true" : undefined}
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
              className={
                selection.isSelecting ? "selectionIndicator" : undefined
              }
            />
          </div>
        </div>
      ))}
    </>
  );
}
