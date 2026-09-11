import "./LibraryView.css";
import type { ReactNode } from "react";
import { TrackList, type TrackListProps } from "./TrackList";
import { secureRandomInt } from "../utils/queueModel";

export type TrackCollectionViewProps = TrackListProps & {
  title: string;
  registerScrollElement: (element: HTMLDivElement | null) => void;
  headerContent?: ReactNode;
  content?: ReactNode;
  showPlaybackActions?: boolean;
  shuffleCollection?: () => void;
  summary?: {
    count: number;
    unit: string;
    showDuration?: boolean;
  };
};

export function TrackCollectionView({
  title,
  registerScrollElement,
  headerContent,
  content,
  showPlaybackActions = true,
  shuffleCollection,
  summary,
  ...trackListProps
}: TrackCollectionViewProps) {
  const { tracks, playTrack } = trackListProps;
  const summaryCount = summary?.count ?? tracks.length;
  const summaryUnit = summary?.unit ?? "track";
  const showDuration = summary?.showDuration ?? true;
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

  const firstTrack = tracks[0];
  const isEmpty = tracks.length === 0;

  function handlePlay() {
    if (firstTrack) playTrack(firstTrack.globalId);
  }

  function handleShuffle() {
    if (shuffleCollection) {
      shuffleCollection();
      return;
    }
    if (!isEmpty) {
      const randomTrack = tracks[secureRandomInt(tracks.length)];
      playTrack(randomTrack.globalId);
    }
  }

  return (
    <div className="libraryView smoothScroll" ref={registerScrollElement}>
      <div className="libraryHeader">
        <h1 className="libraryTitle">{title}</h1>
        {headerContent}
        {showPlaybackActions && (
          <div className="libraryPlayActions">
            <button
              type="button"
              className="libraryPlayBtn"
              onClick={handlePlay}
              disabled={isEmpty}
            >
              <img src="/Play.svg" alt="" aria-hidden="true" />
              <span>PLAY</span>
            </button>
            <button
              type="button"
              className="libraryShuffleBtn"
              onClick={handleShuffle}
              disabled={isEmpty}
            >
              <img src="/shuffle.svg" alt="" aria-hidden="true" />
              <span>SHUFFLE</span>
            </button>
          </div>
        )}
        <div className="libraryInfo">
          <span className="numOfTracks">
            {formatUnit(summaryCount, summaryUnit)}
          </span>
          {showDuration && (
            <>
              <span className="separator">•</span>
              <span className="playlistLength">
                {formatUnit(hours, "hour")}, {formatUnit(minutes, "minute")},{" "}
                {formatUnit(seconds, "second")}
              </span>
            </>
          )}
        </div>
      </div>
      {content ?? <TrackList {...trackListProps} />}
    </div>
  );
}
