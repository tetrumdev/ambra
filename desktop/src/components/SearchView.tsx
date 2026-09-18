import { categoryOrder } from "../utils/catalogRanking";
import { useEffect, useState } from "react";
import { TrackArtwork } from "./TrackArtwork";
import { ArtistPortrait } from "./ArtistPortrait";
import type { CatalogArtist, CatalogAlbum, SearchProvider } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { TrackCollectionMenu, type PlaylistMenuOptions } from "./TrackCollectionMenu";
import { ArtworkImage } from "./ArtworkImage";
import "./LibraryView.css";
import "./SearchView.css";

type SearchViewProps = {
  playlistOptions: PlaylistMenuOptions;
  query: string;
  provider: SearchProvider;
  tracks: Track[];
  candidates: Track[];
  artists: CatalogArtist[];
  albums: CatalogAlbum[];
  isSearching: boolean;
  error: string | null;
  canRetry: boolean;
  retry: () => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
  addToLibrary: (trackId: GlobalTrackId) => void;
  registerScrollElement: (element: HTMLDivElement | null) => void;
};

type OpenMenu = {
  kind: "playback" | "collection";
  trackId: GlobalTrackId;
  x: number;
  y: number;
};

type SearchResultProps = {
  track: Track;
  variant: "featured" | "grid";
  playTrack: (trackId: GlobalTrackId) => void;
  openActions: (event: React.MouseEvent, trackId: GlobalTrackId) => void;
  openCollectionMenu: (
    event: React.MouseEvent<HTMLButtonElement>,
    trackId: GlobalTrackId,
  ) => void;
};

const providerNames: Record<SearchProvider, string> = {
  all: "connected services",
  tidal: "Tidal",
  qobuz: "Qobuz",
  spotify: "Spotify",
};

function trackProviderName(provider: Track["provider"]) {
  switch (provider) {
    case "qobuz":
      return "Qobuz";
    case "tidal":
      return "Tidal";
    case "spotify":
      return "Spotify";
    default:
      return "Local";
  }
}

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
  openCollectionMenu,
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
        <img className="searchArtworkPlay" src="/Play.svg" alt="" aria-hidden="true" />
        <TrackArtwork
          className="searchResultCover"
          track={track}
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
        <div className="searchResultMeta">
          <span className="searchResultQuality">
            {trackProviderName(track.provider)}
            {track.quality ? ` · ${track.quality}` : ""}
          </span>
          <span className="searchResultDuration">
            {formatTime(track.durationSeconds)}
          </span>
        </div>
      </div>

      <button
        className="searchResultMenuButton"
        type="button"
        aria-label={`More options for ${track.name}`}
        onClick={(event) => openCollectionMenu(event, track.globalId)}
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
  candidates,
  artists,
  albums,
  isSearching,
  error,
  canRetry,
  retry,
  playStandalone,
  addToQueue,
  playNext,
  addToLibrary,
  playlistOptions,
  registerScrollElement,
}: SearchViewProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  useEffect(() => setOpenMenu(null), [query, provider]);
  const [featuredTrack, ...remainingTracks] = tracks.slice(0, 5);
  const order = categoryOrder(query, tracks, artists, albums, candidates);
  const sectionStyle = (category: typeof order[number]) => ({ order: order.indexOf(category), gridColumn: order[0] === category ? "1 / -1" : undefined });
  const count = Math.min(tracks.length, 5) + Math.min(artists.length, 5) + Math.min(albums.length, 5);
  const status = isSearching ? `Searching ${providerNames[provider]}…` : `${count} results from ${error ? "available services" : providerNames[provider]}`;

  function openActions(event: React.MouseEvent, trackId: GlobalTrackId) {
    event.preventDefault();
    setOpenMenu({
      kind: "playback",
      trackId,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function openCollectionMenu(
    event: React.MouseEvent<HTMLButtonElement>,
    trackId: GlobalTrackId,
  ) {
    event.preventDefault();
    event.stopPropagation();

    const triggerRect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 180;
    const gap = 4;

    setOpenMenu({
      kind: "collection",
      trackId,
      x: triggerRect.right - menuWidth,
      y: triggerRect.bottom + gap,
    });
  }

  return (
    <div className="searchView smoothScroll" ref={registerScrollElement}>
      {openMenu?.kind === "playback" && (
        <TrackPlaybackMenu
          onClose={() => setOpenMenu(null)}
          xPos={openMenu.x}
          yPos={openMenu.y}
          trackId={openMenu.trackId}
          playStandalone={playStandalone}
          addToQueue={addToQueue}
          playNext={playNext}
        />
      )}
      {openMenu?.kind === "collection" && (
        <TrackCollectionMenu
          trackId={openMenu.trackId}
          playlistOptions={playlistOptions}
          onClose={() => setOpenMenu(null)}
          xPos={openMenu.x}
          yPos={openMenu.y}
          actions={[{ label: "Add to Library", onSelect: () => addToLibrary(openMenu.trackId) }]}
        />
      )}

      <div className="libraryHeader searchResultsHeader">
        <h1 className="libraryTitle">Search</h1>
        <p className="searchQuery">Results for “{query.trim()}”</p>
        <p
          className="searchStatus"
          role="status"
        >
          {status}
        </p>
        {error && (
          <div className="searchError">
            <p className="searchStatus" data-error="true" role="alert">{error}</p>
            {canRetry && <button className="libraryShuffleBtn searchRetryButton" type="button" onClick={retry} disabled={isSearching}>{isSearching ? "Retrying…" : "Retry unavailable services"}</button>}
          </div>
        )}
      </div>

      {count === 0 && !isSearching && !error && <p className="searchEmptyState">No matches found. Try another artist, album, or track name.</p>}
      {count > 0 && (
      <div className="searchContent">
      <div className="searchSectionLayout">
      <section className="searchTrackSection" data-primary={order[0] === "tracks"} style={sectionStyle("tracks")} aria-labelledby="searchTracksHeading">
      <h2 id="searchTracksHeading" className="searchSectionTitle">Tracks</h2>
      {!featuredTrack && <p className="searchSectionEmpty">{isSearching ? "Searching tracks…" : "No tracks found"}</p>}
      {featuredTrack && (
        <div id="searchResults">
          <div id="firstResult">
            <SearchResult
              track={featuredTrack}
              variant="featured"
              playTrack={playStandalone}
              openActions={openActions}
              openCollectionMenu={openCollectionMenu}
            />
          </div>

          {remainingTracks.length > 0 && (
            <div id="searchResultGrid">
              {remainingTracks.map((track) => (
                <SearchResult
                  key={track.globalId}
                  track={track}
                  variant="grid"
                  playTrack={playStandalone}
                  openActions={openActions}
                  openCollectionMenu={openCollectionMenu}
                />
              ))}
            </div>
          )}
        </div>
      )}
      </section>
      <div className="searchEntitySections">
        <section data-primary={order[0] === "artists"} style={sectionStyle("artists")} aria-labelledby="searchArtistsHeading">
          <h2 id="searchArtistsHeading">Artists</h2>
          {!artists.length && <p className="searchEntityEmpty">{isSearching ? "Searching artists…" : "No artists found"}</p>}
          {artists.slice(0, 5).map(artist => <div className="searchEntity searchArtist" key={artist.id}>
            <ArtistPortrait key={artist.id} name={artist.name} fallback={artist.imageUrl} />
            <div className="searchEntityInfo"><strong>{artist.name}</strong><small>{providerNames[artist.provider]}</small></div>
          </div>)}
        </section>
        <section data-primary={order[0] === "albums"} style={sectionStyle("albums")} aria-labelledby="searchAlbumsHeading">
          <h2 id="searchAlbumsHeading">Albums</h2>
          {!albums.length && <p className="searchEntityEmpty">{isSearching ? "Searching albums…" : "No albums found"}</p>}
          {albums.slice(0, 5).map(album => <div className="searchEntity searchAlbum" key={album.id}>
            <div className="searchEntityImage"><ArtworkImage src={album.imageUrl} alt={`${album.title} album cover`} loading="lazy" /></div>
            <div className="searchEntityInfo"><strong>{album.title}{album.version && !album.title.toLowerCase().includes(album.version.toLowerCase()) ? ` (${album.version})` : ""}</strong><span>{album.artist}</span><small>{providerNames[album.provider]}{album.releaseDate ? ` · ${album.releaseDate.slice(0, 4)}` : ""}</small></div>
          </div>)}
        </section>
      </div>
      </div>
      </div>
      )}
    </div>
  );
}
