import "./LibraryView.css";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { TrackList, type TrackListProps } from "./TrackList";
import { secureRandomInt } from "../utils/queueModel";
import { formatTotalDuration } from "../utils/totalDuration";
import { staggerRows } from "../utils/viewMotion";

// Gap between the stuck playlist header's contents and the top of the view.
const COLLAPSED_HEADER_INSET = 16;
// Everything the collapse sets on the scroll element; cleared when it detaches.
const COLLAPSE_PROPERTIES = [
  "--playlist-artwork-scale",
  "--playlist-title-progress",
  "--playlist-title-scale",
  "--playlist-title-shift",
  "--playlist-actions-progress",
  "--playlist-actions-shift",
  "--playlist-details-shift",
  "--playlist-expanded-header-height",
  "--playlist-current-header-height",
  "--playlist-background-scale",
];

type HeaderGeometry = {
  expandedHeight: number;
  bodyHeight: number;
  titleHeight: number;
  actionsHeight: number;
  detailsHeight: number;
  actions: HTMLElement | null;
};

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
  const headerGeometryRef = useRef<HeaderGeometry | null>(null);
  const collapseFrameRef = useRef<number | null>(null);

  const updateCollapsibleHeader = useCallback((element: HTMLDivElement) => {
    const geometry = headerGeometryRef.current;
    if (!collapsibleHeader || !geometry) return;

    // The header keeps its expanded footprint in the layout and only its visible
    // box shrinks, so collapsing never moves the content being scrolled.
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

    const artworkSize =
      145 - 18 * titleProgress - 70 * detailsProgress - 13 * artworkProgress;
    const titleScale = 1 - 0.375 * titleProgress;
    const titleShift =
      165 - (artworkSize + 14 + 6 * (1 - artworkProgress) + 15 * titleLag);
    const actionsShift =
      geometry.titleHeight * (1 - titleScale) + 8 * titleProgress + 6 * detailsProgress;
    const detailsShift = actionsShift + (geometry.actionsHeight + 8) * detailsProgress;
    const bodyHeight = geometry.bodyHeight
      - geometry.titleHeight * (1 - titleScale)
      - 12 * titleProgress
      - (geometry.actionsHeight + geometry.detailsHeight + 14) * detailsProgress;
    const currentHeight = Math.max(44, artworkSize, bodyHeight);

    element.style.setProperty("--playlist-artwork-scale", String(artworkSize / 145));
    element.style.setProperty("--playlist-title-progress", String(titleProgress));
    element.style.setProperty("--playlist-title-scale", String(titleScale));
    element.style.setProperty("--playlist-title-shift", `${titleShift}px`);
    element.style.setProperty("--playlist-actions-progress", String(actionsProgress));
    element.style.setProperty("--playlist-actions-shift", `${actionsShift}px`);
    element.style.setProperty("--playlist-details-shift", `${detailsShift}px`);
    element.style.setProperty("--playlist-current-header-height", `${currentHeight}px`);
    element.style.setProperty(
      "--playlist-background-scale",
      String(
        (currentHeight + COLLAPSED_HEADER_INSET) /
        (geometry.expandedHeight + COLLAPSED_HEADER_INSET),
      ),
    );
    const actionsHidden = actionsProgress >= 0.999;
    element.toggleAttribute("data-playlist-actions-hidden", actionsHidden);
    if (geometry.actions) geometry.actions.inert = actionsHidden;
  }, [collapsibleHeader]);

  const scheduleCollapsibleHeader = useCallback((element: HTMLDivElement) => {
    if (collapseFrameRef.current !== null) return;
    collapseFrameRef.current = requestAnimationFrame(() => {
      collapseFrameRef.current = null;
      updateCollapsibleHeader(element);
    });
  }, [updateCollapsibleHeader]);

  // The first tracks to show, whether there at once or once they load, settle in row by row.
  const rowsArrived = useRef(false);
  useLayoutEffect(() => {
    const element = scrollElementRef.current;
    if (rowsArrived.current || isEmpty || !element) return;
    rowsArrived.current = true;
    staggerRows(element, ".libraryItem");
  }, [isEmpty]);

  const setScrollElement = useCallback((element: HTMLDivElement | null) => {
    scrollElementRef.current = element;
    registerScrollElement(element);
  }, [registerScrollElement]);

  useLayoutEffect(() => {
    const element = scrollElementRef.current;
    if (!element || !collapsibleHeader) return;
    const header = element.querySelector<HTMLElement>(".libraryHeader");
    const body = header?.querySelector<HTMLElement>(".libraryHeaderBody");
    const titleElement = header?.querySelector<HTMLElement>(".libraryTitle");
    if (!header || !body || !titleElement) return;
    const actions = body.querySelector<HTMLElement>(".libraryPlayActions");
    const details = body.querySelector<HTMLElement>(".libraryInfo");
    let measureFrame: number | null = null;

    const measure = () => {
      measureFrame = null;
      // Contents retain their intrinsic dimensions; transforms never trigger this observer.
      const bodyHeight = body.getBoundingClientRect().height;
      const expandedHeight = Math.max(145, bodyHeight);
      headerGeometryRef.current = {
        expandedHeight,
        bodyHeight,
        titleHeight: titleElement.offsetHeight,
        actionsHeight: actions?.offsetHeight ?? 0,
        detailsHeight: details?.offsetHeight ?? 0,
        actions,
      };
      element.style.setProperty("--playlist-expanded-header-height", `${expandedHeight}px`);
      updateCollapsibleHeader(element);
    };
    const scheduleMeasure = () => {
      if (measureFrame === null) measureFrame = requestAnimationFrame(measure);
    };
    measure();
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(element);
    resizeObserver.observe(body);
    // Native sticky positioning includes the top spacer and navigation automatically.
    for (let sibling = header.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      resizeObserver.observe(sibling);
    }
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      if (measureFrame !== null) cancelAnimationFrame(measureFrame);
      if (collapseFrameRef.current !== null) cancelAnimationFrame(collapseFrameRef.current);
      collapseFrameRef.current = null;
      headerGeometryRef.current = null;
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      for (const property of COLLAPSE_PROPERTIES) element.style.removeProperty(property);
      element.removeAttribute("data-playlist-actions-hidden");
      if (actions) actions.inert = false;
    };
  }, [collapsibleHeader, updateCollapsibleHeader, title, headerNavigation, showPlaybackActions, summary === null]);

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
          ? (event) => scheduleCollapsibleHeader(event.currentTarget)
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
        <div className={headerArtwork || collapsibleHeader ? "libraryHeaderBody" : undefined}>
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
