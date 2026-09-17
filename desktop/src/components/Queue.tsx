import { TrackArtwork } from "./TrackArtwork";
import "./Queue.css";
import { useEffect, useMemo } from "react";
import { useRangeSelection } from "../hooks/useRangeSelection";
import type { QueueEntry, QueueId } from "../types/music";

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
  const entrySignature = entries
    .map(
      (entry) =>
        `${entry.queueId}:${entry.track.globalId}:${entry.source.kind}:${entry.source.id}:${entry.source.entryId}`,
    )
    .join("|");

  useEffect(() => {
    selection.clear();
  }, [entrySignature, selection.clear]);

  function selectEntry(event: React.MouseEvent, index: number) {
    event.preventDefault();
    event.stopPropagation();
    selection.toggle(index, event.shiftKey);
  }

  function handleEntryClick(event: React.MouseEvent, index: number) {
    if (selection.isSelecting) selectEntry(event, index);
  }

  function deleteSelection() {
    if (selection.selectedIds.size === 0) return;
    deleteEntries([...selection.selectedIds]);
    selection.clear();
  }

  function selectionIndicator(entry: QueueEntry) {
    if (!selection.isSelecting) return null;
    const selected = selection.selectedIds.has(entry.queueId);
    return (
      <img
        className="queueSelectionIndicator"
        src={selected ? "/select.svg" : "/noSelect.svg"}
        alt={selected ? "Selected" : "Not selected"}
      />
    );
  }

  return (
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
            onClickCapture={(event) => handleEntryClick(event, 0)}
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
            {selectionIndicator(currentEntry)}
          </div>
        )}
      </div>
      <div id="upcomingQueueTracks">
        <span id="upcomingTitle" className="queueSection">
          Upcoming
        </span>
        {upcomingEntries.map((entry, index) => (
          <div
            className={`queueItem ${index === 0 ? "firstQueueItem" : ""}`}
            key={entry.queueId}
            data-selected={
              selection.selectedIds.has(entry.queueId) ? "true" : undefined
            }
            onClickCapture={(event) => handleEntryClick(event, index + 1)}
            onClick={() => jumpTo(entry.queueId)}
            onContextMenu={(event) => selectEntry(event, index + 1)}
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
            {selectionIndicator(entry)}
          </div>
        ))}
      </div>
    </div>
  );
}
