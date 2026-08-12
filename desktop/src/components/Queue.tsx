import "./Queue.css";
import type { QueueEntry, QueueId } from "../types/music";

type QueueProps = {
  currentEntry: QueueEntry | undefined;
  upcomingEntries: QueueEntry[];
  jumpTo: (queueId: QueueId) => void;
  registerScrollElement: (element: HTMLDivElement | null) => void;
};

export function Queue({
  currentEntry,
  upcomingEntries,
  jumpTo,
  registerScrollElement,
}: QueueProps) {
  return (
    <div
      id="queueList"
      className="smoothScroll"
      ref={registerScrollElement}
    >
      <div id="currentQueueTrack">
        <span id="currentTitle" className="queueSection">
          Currently Playing
        </span>
        {currentEntry && (
          <div className="queueItem firstQueueItem">
            <div className="coverImgContainer">
              <img
                src={currentEntry.track.cover}
                alt={`${currentEntry.track.album} album cover`}
                className="coverImg"
              />
            </div>
            <span className="trackName">{currentEntry.track.name}</span>
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
            onClick={() => jumpTo(entry.queueId)}
          >
            <div className="coverImgContainer">
              <img
                src={entry.track.cover}
                alt={`${entry.track.album} album cover`}
                className="coverImg"
              />
            </div>
            <span className="trackName">{entry.track.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
