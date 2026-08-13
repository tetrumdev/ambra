import { useState } from "react";
import type { SearchProvider } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { ClickMenu } from "./ClickMenu";
import { SearchMenu } from "./SearchMenu";
import "./SearchView.css";

type SearchViewProps = {
  query: string;
  provider: SearchProvider;
  tracks: Track[];
  isSearching: boolean;
  error: string | null;
  playTrack: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
  addToLibrary: (trackId: GlobalTrackId) => void;
  registerScrollElement: (element: HTMLDivElement | null) => void;
};

type OpenMenu = {
  kind: "actions" | "library";
  trackId: GlobalTrackId;
  x: number;
  y: number;
};

type SearchResultProps = {
  track: Track;
  variant: "featured" | "grid";
  playTrack: (trackId: GlobalTrackId) => void;
  openActions: (event: React.MouseEvent, trackId: GlobalTrackId) => void;
  openLibraryMenu: (
    event: React.MouseEvent<HTMLButtonElement>,
    trackId: GlobalTrackId,
  ) => void;
};

const providerNames: Record<SearchProvider, string> = {
  tidal: "Tidal",
  qobuz: "Qobuz",
  spotify: "Spotify",
};

function formatTime(time: number) {
  const totalSeconds = Math.max(0, Math.floor(time));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

function SearchResult({
  track,
  variant,
  playTrack,
  openActions,
  openLibraryMenu,
}: SearchResultProps) {
  return (
    <div
      className="searchResult"
      data-variant={variant}
      data-track-id={track.globalId}
      onClick={(event) => openActions(event, track.globalId)}
      onContextMenu={(event) => openActions(event, track.globalId)}
    >
      <button
        className="searchResultArtwork"
        type="button"
        aria-label={`Play ${track.name}`}
        onClick={(event) => {
          event.stopPropagation();
          playTrack(track.globalId);
        }}
      >
        <img
          className="searchResultCover"
          src={track.cover}
          alt={`${track.album} album cover`}
          width={124}
          height={124}
          loading={variant === "featured" ? "eager" : "lazy"}
          fetchPriority={variant === "featured" ? "high" : "auto"}
          decoding="async"
        />
      </button>

      <div className="searchResultInfo">
        <div className="searchResultName">{track.name}</div>
        <div className="searchResultArtist">By {track.artist}</div>
        <div className="searchResultAlbum">On {track.album}</div>
        <div className="searchResultDuration">
          {formatTime(track.durationSeconds)}
        </div>
        {track.quality && (
          <div className="searchResultQuality">{track.quality}</div>
        )}
      </div>

      <button
        className="searchResultMenuButton"
        type="button"
        aria-label={`More options for ${track.name}`}
        onClick={(event) => openLibraryMenu(event, track.globalId)}
      >
        <img src="/menu.svg" alt="" />
      </button>
    </div>
  );
}

export function SearchView({
  query,
  provider,
  tracks,
  isSearching,
  error,
  playTrack,
  playStandalone,
  addToQueue,
  playNext,
  addToLibrary,
  registerScrollElement,
}: SearchViewProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  const [featuredTrack, ...remainingTracks] = tracks;

  let status = `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"} from ${providerNames[provider]}`;
  if (isSearching) status = `Searching ${providerNames[provider]}…`;
  else if (error) status = error;
  else if (tracks.length === 0) status = "No songs found";

  function openActions(event: React.MouseEvent, trackId: GlobalTrackId) {
    event.preventDefault();
    setOpenMenu({
      kind: "actions",
      trackId,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function openLibraryMenu(
    event: React.MouseEvent<HTMLButtonElement>,
    trackId: GlobalTrackId,
  ) {
    event.preventDefault();
    event.stopPropagation();

    const triggerRect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 180;
    const menuHeight = 55;
    const gap = 4;
    const fitsBelow =
      triggerRect.bottom + gap + menuHeight <= window.innerHeight;

    setOpenMenu({
      kind: "library",
      trackId,
      x: triggerRect.right - menuWidth,
      y: fitsBelow
        ? triggerRect.bottom + gap
        : triggerRect.top - menuHeight - gap,
    });
  }

  return (
    <div className="searchView smoothScroll" ref={registerScrollElement}>
      {openMenu?.kind === "actions" && (
        <ClickMenu
          hideClickMenu={() => setOpenMenu(null)}
          xPos={openMenu.x}
          yPos={openMenu.y}
          trackId={openMenu.trackId}
          playTrack={playTrack}
          playStandalone={playStandalone}
          addToQueue={addToQueue}
          playNext={playNext}
        />
      )}
      {openMenu?.kind === "library" && (
        <SearchMenu
          hideSearchMenu={() => setOpenMenu(null)}
          xPos={openMenu.x}
          yPos={openMenu.y}
          trackId={openMenu.trackId}
          addToLibrary={addToLibrary}
        />
      )}

      <div className="libraryHeader searchResultsHeader">
        <h1 className="libraryTitle">Search</h1>
        <p className="searchQuery">Results for “{query.trim()}”</p>
        <p
          className="searchStatus"
          role={error ? "alert" : "status"}
          data-error={error ? "true" : undefined}
        >
          {status}
        </p>
      </div>

      {featuredTrack && (
        <div id="searchResults">
          <div id="firstResult">
            <SearchResult
              track={featuredTrack}
              variant="featured"
              playTrack={playTrack}
              openActions={openActions}
              openLibraryMenu={openLibraryMenu}
            />
          </div>

          {remainingTracks.length > 0 && (
            <div id="searchResultGrid">
              {remainingTracks.map((track) => (
                <SearchResult
                  key={track.globalId}
                  track={track}
                  variant="grid"
                  playTrack={playTrack}
                  openActions={openActions}
                  openLibraryMenu={openLibraryMenu}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
