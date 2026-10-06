import "./LibraryView.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { TrackList, type TrackListProps } from "./TrackList";
import { secureRandomInt } from "../utils/queueModel";
import { formatTotalDuration } from "../utils/totalDuration";

export type TrackCollectionViewProps = TrackListProps & {
  title: string;
  className?: string;
  headerNavigation?: ReactNode;
  playbackActions?: ReactNode;
  registerScrollElement: (element: HTMLDivElement | null) => void;
  headerContent?: ReactNode;
  headerArtwork?: ReactNode;
  content?: ReactNode;
  showPlaybackActions?: boolean;
  collapsibleHeader?: boolean;
  shuffleCollection?: () => void;
  summary?: {
    count: number;
    unit: string;
    showDuration?: boolean;
  } | null;
};

export function TrackCollectionView({
  title,
  className = "",
  headerNavigation,
  playbackActions,
  registerScrollElement,
  headerContent,
  headerArtwork,
  content,
  showPlaybackActions = true,
  collapsibleHeader = false,
  shuffleCollection,
  summary,
  ...trackListProps
}: TrackCollectionViewProps) {
  const { tracks, playTrack } = trackListProps;
  const summaryCount = summary?.count ?? tracks.length;
  const summaryUnit = summary?.unit ?? "track";
  const showDuration = summary?.showDuration ?? true;
  const totalDurationSeconds = useMemo(() => tracks.reduce(
    (total, track) => total + track.durationSeconds,
    0,
  ), [tracks]);
  function formatUnit(value: number, unit: string) {
    return `${value} ${unit}${value === 1 ? "" : "s"}`;
  }

  const firstTrack = tracks[0];
  const isEmpty = tracks.length === 0;
  const scrollElementRef = useRef<HTMLDivElement | null>(null);

  const updateCollapsibleHeader = useCallback((element: HTMLDivElement) => {
    if (!collapsibleHeader) return;

    const collapseDistance = 280;
    const rawProgress = Math.min(
      1,
      Math.max(0, element.scrollTop / collapseDistance),
    );
    const ease = (value: number) =>
      1 - (1 - value) ** 3 * (1 + 2.55 * value);
    const smooth = (value: number) => value * value * (3 - 2 * value);
    const segment = (start: number, end: number) =>
      Math.min(
        1,
        Math.max(0, (rawProgress - start) / (end - start)),
      );
    const artworkProgress = ease(rawProgress);
    const titleLag =
      16 *
      rawProgress *
      rawProgress *
      (1 - rawProgress) *
      (1 - rawProgress);
    const titleProgress = ease(segment(0.04, 1));
    const actionsProgress = ease(segment(0, 0.48));
    const detailsProgress = smooth(segment(0.48, 1));

    element.style.setProperty(
      "--playlist-artwork-progress",
      String(artworkProgress),
    );
    element.style.setProperty(
      "--playlist-title-progress",
      String(titleProgress),
    );
    element.style.setProperty("--playlist-title-lag", String(titleLag));
    element.style.setProperty(
      "--playlist-actions-progress",
      String(actionsProgress),
    );
    element.style.setProperty(
      "--playlist-details-progress",
      String(detailsProgress),
    );
    const header = element.querySelector<HTMLElement>(".libraryHeader");
    if (header) {
      element.style.setProperty(
        "--playlist-current-header-height",
        `${header.getBoundingClientRect().height}px`,
      );
    }
    element.toggleAttribute(
      "data-playlist-actions-hidden",
      actionsProgress >= 0.999,
    );
  }, [collapsibleHeader]);

  const setScrollElement = useCallback((element: HTMLDivElement | null) => {
    scrollElementRef.current = element;
    registerScrollElement(element);
    if (element) updateCollapsibleHeader(element);
  }, [registerScrollElement, updateCollapsibleHeader]);

  useEffect(() => {
    const element = scrollElementRef.current;
    if (!element || !collapsibleHeader) return;

    const update = () => updateCollapsibleHeader(element);
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(element);
    window.addEventListener("resize", update);
    const updateFrame = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(updateFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [collapsibleHeader, updateCollapsibleHeader]);

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
    <div
      className={`libraryView smoothScroll ${className}${collapsibleHeader ? " playlistView" : ""}`}
      ref={setScrollElement}
      onScroll={
        collapsibleHeader
          ? (event) => updateCollapsibleHeader(event.currentTarget)
          : undefined
      }
    >
      {collapsibleHeader && (
        <div className="playlistHeaderAnchor" aria-hidden="true" />
      )}
      {headerNavigation && <div className="libraryHeaderNavigation">{headerNavigation}</div>}
      <div className="libraryHeader">
        {headerArtwork && (
          <div className="libraryHeaderArtwork">{headerArtwork}</div>
        )}
        <div className={headerArtwork ? "libraryHeaderBody" : undefined}>
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
              {playbackActions}
            </div>
          )}
          {summary !== null && <div className="libraryInfo">
            <span className="numOfTracks">
              {formatUnit(summaryCount, summaryUnit)}
            </span>
            {showDuration && (
              <>
                <span className="separator">•</span>
                <span className="playlistLength">
                  {formatTotalDuration(totalDurationSeconds)}
                </span>
              </>
            )}
          </div>}
        </div>
      </div>
      {content ?? <TrackList {...trackListProps} />}
    </div>
  );
}
