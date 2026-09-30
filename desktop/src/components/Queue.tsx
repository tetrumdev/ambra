import { TrackArtwork } from "./TrackArtwork";
import "./Queue.css";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useRangeSelection } from "../hooks/useRangeSelection";
import type { QueueEntry, QueueId } from "../types/music";
import { PerfProfiler } from "./PerfProfiler";
import { VirtualSpacer } from "./VirtualSpacer";
import { useVirtualWindow } from "../hooks/useVirtualWindow";

const VIRTUALIZE_AFTER_ENTRIES = 120;

type QueueProps = {
  currentEntry: QueueEntry | undefined;
  upcomingEntries: QueueEntry[];
  jumpTo: (queueId: QueueId) => void;
  deleteEntries: (queueIds: QueueId[]) => void;
  registerScrollElement: (element: HTMLDivElement | null) => void;
};

export function Queue({
  currentEntry,
  upcomingEntries,
  jumpTo,
  deleteEntries,
  registerScrollElement,
}: QueueProps) {
  const entries = useMemo(
    () => (currentEntry ? [currentEntry, ...upcomingEntries] : upcomingEntries),
    [currentEntry, upcomingEntries],
  );
  const queueIds = useMemo(
    () => entries.map((entry) => entry.queueId),
    [entries],
  );
  const selection = useRangeSelection(queueIds);
  const entrySignature = useMemo(
    () => entries
      .map(
        (entry) =>
          `${entry.queueId}:${entry.track.globalId}:${entry.source.kind}:${entry.source.id}:${entry.source.entryId}`,
      )
      .join("|"),
    [entries],
  );
  const upcomingRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualWindow({
    count: upcomingEntries.length,
    enabled: upcomingEntries.length > VIRTUALIZE_AFTER_ENTRIES,
    probeRef: upcomingRef,
    probeIsContainer: true,
    fallback: { rowHeight: 76 },
    cacheKey: "queue-list",
    overscanRows: 10,
  });

  useEffect(() => {
    selection.clear();
  }, [entrySignature, selection.clear]);

  function selectEntry(event: React.MouseEvent, index: number) {
    event.preventDefault();
    event.stopPropagation();
    selection.toggle(index, event.shiftKey);
  }

  function deleteSelection() {
    if (selection.selectedIds.size === 0) return;
    deleteEntries([...selection.selectedIds]);
    selection.clear();
  }

  const entryActions = useRef<(action: "click" | "select", event: React.MouseEvent, entry: QueueEntry, index: number) => void>(() => {});
  entryActions.current = (action, event, entry, index) => {
    if (action === "select") selectEntry(event, index);
    else if (selection.isSelecting) selectEntry(event, index);
    else jumpTo(entry.queueId);
  };
  const onEntryAction = useCallback((action: "click" | "select", event: React.MouseEvent, entry: QueueEntry, index: number) => {
    entryActions.current(action, event, entry, index);
  }, []);

  return (
    <PerfProfiler id="queue">
    <div id="queueList" className="smoothScroll" ref={registerScrollElement}>
      <div id="currentQueueTrack">
        <span id="currentTitle" className="queueSection">
          Currently Playing
          {selection.isSelecting && (
            <button
              className="selectionDeleteButton queueSelectionDeleteButton"
              type="button"
              disabled={selection.selectedIds.size === 0}
              onClick={deleteSelection}
            >
              Delete from queue
            </button>
          )}
        </span>
        {currentEntry && (
          <div
            className="queueItem firstQueueItem"
            data-selected={
              selection.selectedIds.has(currentEntry.queueId)
                ? "true"
                : undefined
            }
            onClickCapture={(event) => {
              if (selection.isSelecting) selectEntry(event, 0);
            }}
            onContextMenu={(event) => selectEntry(event, 0)}
          >
            <div className="coverImgContainer">
              <TrackArtwork
                track={currentEntry.track}
                loading="eager"
                alt={`${currentEntry.track.album} album cover`}
                className="coverImg"
              />
            </div>
            <div className="queueTrackInfo">
              <span className="trackName">{currentEntry.track.name}</span>
              <span className="artistName">{currentEntry.track.artist}</span>
              {/*<span className="trackDuration">{currentEntry.track.durationSeconds}</span>*/}
            </div>
            {selection.isSelecting && (
              <SelectionIndicator selected={selection.selectedIds.has(currentEntry.queueId)} />
            )}
          </div>
        )}
      </div>
      <div id="upcomingQueueTracks" ref={upcomingRef} role="list" aria-label="Upcoming queue">
        <span id="upcomingTitle" className="queueSection">
          Upcoming
        </span>
        {virtual.topSpace > 0 && <VirtualSpacer position="top" height={virtual.topSpace} />}
        {upcomingEntries.slice(virtual.start, virtual.end).map((entry, windowIndex) => {
          const index = virtual.start + windowIndex;
          const selectionIndex = index + (currentEntry ? 1 : 0);
          return (
          <QueueRow
            key={entry.queueId}
            entry={entry}
            selectionIndex={selectionIndex}
            position={index + 1}
            count={upcomingEntries.length}
            first={index === 0}
            selecting={selection.isSelecting}
            selected={selection.selectedIds.has(entry.queueId)}
            onAction={onEntryAction}
          />
          );
        })}
        {virtual.bottomSpace > 0 && <VirtualSpacer position="bottom" height={virtual.bottomSpace} />}
      </div>
    </div>
    </PerfProfiler>
  );
}

const SelectionIndicator = memo(function SelectionIndicator({ selected }: { selected: boolean }) {
  return (
    <img
      className="queueSelectionIndicator"
      src={selected ? "/select.svg" : "/noSelect.svg"}
      alt={selected ? "Selected" : "Not selected"}
    />
  );
});

const QueueRow = memo(function QueueRow({ entry, selectionIndex, position, count, first, selecting, selected, onAction }: {
  entry: QueueEntry;
  selectionIndex: number;
  position: number;
  count: number;
  first: boolean;
  selecting: boolean;
  selected: boolean;
  onAction: (action: "click" | "select", event: React.MouseEvent, entry: QueueEntry, index: number) => void;
}) {
  return (
    <div
      className={`queueItem ${first ? "firstQueueItem" : ""}`}
      role="listitem"
      aria-posinset={position}
      aria-setsize={count}
      data-virtual-item=""
      data-selected={selected ? "true" : undefined}
      onClick={(event) => onAction("click", event, entry, selectionIndex)}
      onContextMenu={(event) => onAction("select", event, entry, selectionIndex)}
    >
      <div className="coverImgContainer">
        <TrackArtwork
          track={entry.track}
          alt={`${entry.track.album} album cover`}
          className="coverImg"
        />
      </div>
      <div className="queueTrackInfo">
        <span className="trackName">{entry.track.name}</span>
        <span className="artistName">{entry.track.artist}</span>
      </div>
      {selecting && <SelectionIndicator selected={selected} />}
    </div>
  );
});
