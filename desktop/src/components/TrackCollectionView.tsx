import "./LibraryView.css";
import { TrackList, type TrackListProps } from "./TrackList";

export type TrackCollectionViewProps = TrackListProps & {
  title: string;
  registerScrollElement: (element: HTMLDivElement | null) => void;
};

export function TrackCollectionView({
  title,
  registerScrollElement,
  ...trackListProps
}: TrackCollectionViewProps) {
  const { tracks } = trackListProps;
  const totalDurationSeconds = tracks.reduce(
    (total, track) => total + track.durationSeconds,
    0,
  );
  const hours = Math.floor(totalDurationSeconds / 3600);
  const minutes = Math.floor((totalDurationSeconds % 3600) / 60);
  const seconds = Math.floor(totalDurationSeconds % 60);

  function formatUnit(value: number, unit: string) {
    return `${value} ${unit}${value === 1 ? "" : "s"}`;
  }

  return (
    <div className="libraryView smoothScroll" ref={registerScrollElement}>
      <div className="libraryHeader">
        <h1 className="libraryTitle">{title}</h1>
        <div className="libraryInfo">
          <span className="numOfTracks">
            {formatUnit(tracks.length, "track")}
          </span>
          <span className="separator">•</span>
          <span className="playlistLength">
            {formatUnit(hours, "hour")}, {formatUnit(minutes, "minute")},{" "}
            {formatUnit(seconds, "second")}
          </span>
        </div>
      </div>
      <TrackList {...trackListProps} />
    </div>
  );
}
