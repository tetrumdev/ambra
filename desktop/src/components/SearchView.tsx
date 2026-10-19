import { albumForTrack, type BrowseEntity } from "../utils/browse";
import { ArtistLinks } from "./ArtistLinks";
import { categoryOrder } from "../utils/catalogRanking";
import { ProviderIcon } from "./ProviderIcon";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TrackArtwork } from "./TrackArtwork";
import { ArtistPortrait } from "./ArtistPortrait";
import { prefetchArtistPage } from "../utils/artistPage";
import type { CatalogArtist, CatalogAlbum, SearchProvider } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { TrackCollectionMenu, type PlaylistMenuOptions } from "./TrackCollectionMenu";
import { ArtworkImage } from "./ArtworkImage";
import "./LibraryView.css";
import "./SearchView.css";

type SearchViewProps = {
  onOpenEntity: (entity: BrowseEntity) => void;
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
  onOpenEntity: (entity: BrowseEntity) => void;
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

/** Album quality in the same shape tracks report it, e.g. "24-bit/96 kHz". */
function albumQuality(album: CatalogAlbum) {
  if (!album.maximumBitDepth) return null;
  return album.maximumSamplingRateKHz
    ? `${album.maximumBitDepth}-bit/${Number(album.maximumSamplingRateKHz.toFixed(1))} kHz`
    : `${album.maximumBitDepth}-bit`;
}

/** One link per credited album artist, falling back to plain text when the service gave no IDs. */
function AlbumArtistLinks({ album, onOpenEntity }: { album: CatalogAlbum; onOpenEntity: (entity: BrowseEntity) => void }) {
  const artists = album.artists?.filter((artist) => artist.providerId) ?? [];
  if (!artists.length) return <>{album.artist}</>;
  return <>{artists.map((artist, index) => <Fragment key={artist.providerId}>
    {index > 0 && ", "}
    <button type="button" className="entityLink" onClick={(event) => {
      event.stopPropagation();
      onOpenEntity({ kind: "artist", artist: { id: `${album.provider}:${artist.providerId}`, provider: album.provider, name: artist.name, imageUrl: artist.imageUrl } });
    }}>{artist.name}</button>
  </Fragment>)}</>;
}

const GLIDE_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * Results arrive from each service at different times and get re-ranked as they do.
 * Every result keeps its place on screen for a moment and glides to where it now
 * belongs, and results that are new rise in, instead of the grid jumping.
 */
function useResultGlide(root: React.RefObject<HTMLDivElement | null>, changes: unknown[]) {
  const positions = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const container = root.current;
    if (!container) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const base = container.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number }>();
    let arrivals = 0;
    for (const element of container.querySelectorAll<HTMLElement>("[data-glide]")) {
      const rect = element.getBoundingClientRect();
      // Measured within the scrolled content, so scrolling between updates is not mistaken for movement.
      const position = { x: rect.left - base.left + container.scrollLeft, y: rect.top - base.top + container.scrollTop };
      const key = element.dataset.glide!;
      next.set(key, position);
      if (reduced) continue;
      const previous = positions.current.get(key);
      if (!previous) {
        element.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }],
          { duration: 420, delay: Math.min(arrivals++ * 35, 240), easing: GLIDE_EASE, fill: "backwards" });
        continue;
      }
      const dx = previous.x - position.x;
      const dy = previous.y - position.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 480, easing: GLIDE_EASE });
    }
    positions.current = next;
  }, changes);
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
  onOpenEntity,
  playTrack,
  openActions,
  openCollectionMenu,
}: SearchResultProps) {
  return (
    <div
      className="searchResult"
      data-variant={variant}
      data-track-id={track.globalId}
      data-glide={`track:${track.globalId}`}
      onClick={(event) => openActions(event, track.globalId)}
      onContextMenu={(event) => openActions(event, track.globalId)}
    >
      <div className="trackLeading searchResultLeading">
        <button type="button" className="trackPlayButton" aria-label={`Play ${track.name}`}
          onClick={event => { event.stopPropagation(); playTrack(track.globalId); }}>
          <img src="/Play.svg" alt="" aria-hidden="true" />
        </button>
        <div className="searchResultArtwork">
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
        </div>
      </div>

      <div className="searchResultInfo">
        <div className="searchResultName">{track.name}</div>
        <div className="searchResultArtist">By <ArtistLinks track={track} onOpenEntity={onOpenEntity} /></div>
        <div className="searchResultAlbum">On <button type="button" className="entityLink" onClick={event => { event.stopPropagation(); onOpenEntity({ kind: "album", album: albumForTrack(track) }); }}>{track.album}</button></div>
        <div className="searchResultMeta">
          <span className="searchResultQuality">
            <ProviderIcon provider={track.provider} />
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
  onOpenEntity,
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
  const root = useRef<HTMLDivElement | null>(null);
  const attachRoot = useCallback((element: HTMLDivElement | null) => {
    root.current = element;
    registerScrollElement(element);
  }, [registerScrollElement]);
  useResultGlide(root, [tracks, artists, albums]);
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
    <div className="searchView smoothScroll" ref={attachRoot}>
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
              onOpenEntity={onOpenEntity}
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
              onOpenEntity={onOpenEntity}
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
          {artists.slice(0, 5).map(artist => <button type="button" className="searchEntity searchArtist" key={artist.id} data-glide={`artist:${artist.id}`} onPointerEnter={() => prefetchArtistPage(artist)} onFocus={() => prefetchArtistPage(artist)} onClick={() => onOpenEntity({ kind: "artist", artist })}>
            <ArtistPortrait key={artist.id} artist={artist} />
            <div className="searchEntityInfo"><strong>{artist.name}</strong><small>Artist</small></div>
          </button>)}
        </section>
        <section data-primary={order[0] === "albums"} style={sectionStyle("albums")} aria-labelledby="searchAlbumsHeading">
          <h2 id="searchAlbumsHeading">Albums</h2>
          {!albums.length && <p className="searchEntityEmpty">{isSearching ? "Searching albums…" : "No albums found"}</p>}
          {albums.slice(0, 5).map(album => {
            const title = `${album.title}${album.version && !album.title.toLowerCase().includes(album.version.toLowerCase()) ? ` (${album.version})` : ""}`;
            const quality = albumQuality(album);
            const open = () => onOpenEntity({ kind: "album", album });
            // A card rather than one button, so the artist names inside it can be links of their own.
            return <div className="searchEntity searchAlbum" key={album.id} data-glide={`album:${album.id}`} onClick={open}>
              <div className="searchEntityImage"><ArtworkImage src={album.imageUrl} alt={`${album.title} album cover`} loading="lazy" /></div>
              <div className="searchEntityInfo">
                <button type="button" className="searchEntityTitle" onClick={(event) => { event.stopPropagation(); open(); }}><strong>{title}</strong></button>
                <span><AlbumArtistLinks album={album} onOpenEntity={onOpenEntity} /></span>
                <small><ProviderIcon provider={album.provider} />{quality ? ` · ${quality}` : ""}{album.releaseDate ? ` · ${album.releaseDate.slice(0, 4)}` : ""}</small>
              </div>
            </div>;
          })}
        </section>
      </div>
      </div>
      </div>
      )}
    </div>
  );
}
