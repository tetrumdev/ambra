import "./Queue.css";
import type { QueueEntry } from "../types/music";

type QueueProps = {
  currentEntry: QueueEntry | undefined;
  upcomingEntries: QueueEntry[];
};

export function Queue({ currentEntry, upcomingEntries }: QueueProps) {
  return (
    <div id="queueList">
      <div id="currentQueueTrack">
        {currentEntry && (
          <div className="queueTrack">{currentEntry.track.name}</div>
        )}
      </div>

      <div id="upcomingQueueTracks">
        {upcomingEntries.map((entry) => (
          <div key={`queue:${entry.queueId}`} className="queueTrack">
            {entry.track.name}
          </div>
        ))}
      </div>
    </div>
  );
}
