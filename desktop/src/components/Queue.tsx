import "./Queue.css";
import type { QueueEntry } from "../types/music";

type QueueProps = {
  currentEntry: QueueEntry | undefined;
  upcomingEntries: QueueEntry[];
  // track: Track[];
};

export function Queue({ currentEntry, upcomingEntries }: QueueProps) {
  return (
    <div id="queueList">
      <div id="currentQueueTrack">
        <span id="currentTitle">Currently Playing</span>
        {currentEntry && (
          <div className="queueItem">
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
        <span id="upcomingTitle">Upcoming</span>
        {upcomingEntries.map((entry) => (
          <div className="queueItem">
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
