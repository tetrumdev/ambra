import "./Queue.css";
import type { QueueEntry, GlobalTrackId } from "../types/music";

type QueueProps = {
  currentEntry: QueueEntry | undefined;
  upcomingEntries: QueueEntry[];
  playTrack: (trackId: GlobalTrackId) => void;
};

export function Queue({
  currentEntry,
  upcomingEntries,
  playTrack,
}: QueueProps) {
  return (
    <div id="queueList">
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
            onClick={() => playTrack(entry.track.globalId)}
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
