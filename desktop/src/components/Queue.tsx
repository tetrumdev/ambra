import "./Queue.css";
import type { LibraryTrack, QueueEntry, Track } from "../types/music";

type QueueProps = {
  track: Track;
  tracks: LibraryTrack[];
};

function upcomingQueue(tracks: LibraryTrack[], currentTrack: Track): QueueEntry[] {
  const currentIndex = tracks.findIndex(
    (track) => track.globalId === currentTrack.globalId,
  );
  if (currentIndex < 0) return [];

  return tracks.slice(currentIndex).map((track, index) => ({
    queueId: index + 1,
    track,
  }));
}

export function Queue({ tracks, track: currentTrack }: QueueProps) {
  const entries = upcomingQueue(tracks, currentTrack);

  return (
    <div id="queueList">
      {entries.map((entry) => (
        <div key={entry.queueId} id="test">
          {entry.track.name}
        </div>
      ))}
    </div>
  );
}
