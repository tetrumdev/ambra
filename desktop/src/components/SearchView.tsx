import { albumForTrack, type BrowseEntity } from "../utils/browse";
import { ArtistLinks } from "./ArtistLinks";
import { AlbumArtistLinks } from "./AlbumArtistLinks";
import { categoryOrder } from "../utils/catalogRanking";
import { ProviderIcon } from "./ProviderIcon";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TrackArtwork } from "./TrackArtwork";
import { ArtistPortrait } from "./ArtistPortrait";
import { prefetchArtistPage } from "../utils/artistPage";
import type { CatalogArtist, CatalogAlbum, SearchProvider } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { isTrackAvailable, useServiceAvailability } from "../hooks/useServiceAvailability";
import { TrackCollectionMenu, type PlaylistMenuOptions } from "./TrackCollectionMenu";
import { MENU_WIDTH, isKeyboardMenuClick } from "../utils/trackMenu";
import { showTrackCredits } from "../utils/trackCredits";
import { ArtworkImage } from "./ArtworkImage";
import "./LibraryView.css";
import "./SearchView.css";
import { motion } from "../utils/motion";
import { reducedMotion } from "../utils/reducedMotion";

type SearchViewProps = {
  onOpenEntity: (entity: BrowseEntity) => void;
  playlistOptions: PlaylistMenuOptions;
  query: string;
  provider: SearchProvider;
  tracks: Track[];
  /** Every copy found, services and editions included, for a section's "show all". */
  allTracks: Track[];
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
  /** Where the collection menu opens upward from near the bottom. */
  flipY?: number;
  openedWithKeyboard?: boolean;
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

/**
 * Results arrive from each service at different times and get re-ranked as they do.
 * Every result keeps its place on screen for a moment and glides to where it now
 * belongs, and results that are new rise in, instead of the grid jumping.
 */
function useResultGlide(root: React.RefObject<HTMLDivElement | null>, changes: unknown[]) {
  // Layout positions, without any glide in progress.
  const positions = useRef(new Map<string, { x: number; y: number }>());
  // Only these are retargeted; CSS transitions such as hover fades are left alone.
  const glides = useRef(new WeakMap<HTMLElement, Animation[]>());
  useLayoutEffect(() => {
    const container = root.current;
    if (!container) return;
    const reduced = reducedMotion();
    const base = container.getBoundingClientRect();
    // Read everything before animating anything, so the pass costs one layout.
    const measured = Array.from(container.querySelectorAll<HTMLElement>("[data-glide]"), (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      // Where a running glide currently draws the element, relative to its layout box.
      const offset = style.transform === "none" ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(style.transform);
      return {
        element,
        key: element.dataset.glide!,
        offset: { x: offset.m41, y: offset.m42 },
        opacity: Number(style.opacity),
        // Measured within the scrolled content, so scrolling between updates is not mistaken for movement.
        position: {
          x: rect.left - base.left + container.scrollLeft - offset.m41,
          y: rect.top - base.top + container.scrollTop - offset.m42,
        },
      };
    });
    const next = new Map<string, { x: number; y: number }>();
    let arrivals = 0;
    for (const { element, key, offset, opacity, position } of measured) {
      next.set(key, position);
      if (reduced) continue;
      const inFlight = (glides.current.get(element) ?? []).filter((animation) => animation.playState !== "finished");
      const previous = positions.current.get(key);
      if (!previous) {
        if (inFlight.length) continue;
        glides.current.set(element, [element.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }],
          { ...motion.smooth, delay: Math.min(arrivals++ * 35, 240), fill: "backwards" })]);
        continue;
      }
      // Unmoved results keep whatever glide they are in, rather than restarting it.
      if (Math.abs(previous.x - position.x) < 0.5 && Math.abs(previous.y - position.y) < 0.5) continue;
      // Start from where the result is drawn right now, so a glide that is interrupted bends
      // toward its new place instead of jumping back to where the last one began.
      const dx = previous.x + offset.x - position.x;
      const dy = previous.y + offset.y - position.y;
      for (const animation of inFlight) animation.cancel();
      // A result already moving carries on without the gentle start, so it never stalls mid-flight.
      const timing = inFlight.length ? { ...motion.smooth, easing: motion.enter.easing } : motion.smooth;
      const started = [element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], timing)];
      if (opacity < 1) started.push(element.animate([{ opacity }, { opacity: 1 }], timing));
      glides.current.set(element, started);
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
  const connected = useServiceAvailability();
  const available = isTrackAvailable(track, connected);
  return (
    <div
      className="searchResult"
      data-unavailable={!available ? "true" : undefined}
      data-variant={variant}
      data-track-id={track.globalId}
      data-glide={`track:${track.globalId}`}
      onClick={available ? (event) => openActions(event, track.globalId) : undefined}
      onContextMenu={available ? (event) => openActions(event, track.globalId) : undefined}
    >
      <div className="trackLeading searchResultLeading" inert={!available}>
        <button type="button" className="trackPlayButton" aria-label={`Play ${track.name}`}
          onClick={event => { event.stopPropagation(); playTrack(track.globalId); }}>
          <img src="/play.svg" alt="" aria-hidden="true" />
        </button>
        <div className="searchResultArtwork">
          <TrackArtwork
            preferProviderThumbnail
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

      <div className="searchResultInfo" inert={!available}>
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
        disabled={!available}
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
  allTracks,
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
  // Each section shows its five best until asked for all; for tracks, "all" is every copy
  // found, so a particular service or edition can be picked without narrowing the search.
  const [expanded, setExpanded] = useState<ReadonlySet<"tracks" | "artists" | "albums">>(new Set());
  useEffect(() => setExpanded(new Set()), [query, provider]);
  const toggleSection = (section: "tracks" | "artists" | "albums") => setExpanded(current => {
    const next = new Set(current);
    if (!next.delete(section)) next.add(section);
    return next;
  });
  const shownTracks = useMemo(() => expanded.has("tracks") ? allTracks : tracks.slice(0, 5), [expanded, allTracks, tracks]);
  const shownArtists = useMemo(() => expanded.has("artists") ? artists : artists.slice(0, 5), [expanded, artists]);
  const shownAlbums = useMemo(() => expanded.has("albums") ? albums : albums.slice(0, 5), [expanded, albums]);
  const showAll = (section: "tracks" | "artists" | "albums", total: number) => (expanded.has(section) || total > 5) && (
    <button type="button" className="searchShowAll" aria-expanded={expanded.has(section)} onClick={() => toggleSection(section)}>
      {expanded.has(section) ? "Show fewer" : "Show all"}
    </button>
  );
  useResultGlide(root, [shownTracks, shownArtists, shownAlbums]);
  const [featuredTrack, ...remainingTracks] = shownTracks;
  const order = categoryOrder(query, tracks, artists, albums, candidates);
  const sectionStyle = (category: typeof order[number]) => ({ order: order.indexOf(category), gridColumn: order[0] === category ? "1 / -1" : undefined });
  const count = shownTracks.length + shownArtists.length + shownAlbums.length;
  const status = isSearching ? `Searching ${providerNames[provider]}…` : `${count} results from ${error ? "available services" : providerNames[provider]}`;

  function openActions(event: React.MouseEvent, trackId: GlobalTrackId) {
    event.preventDefault();
    setOpenMenu({
      kind: "playback",
      openedWithKeyboard: isKeyboardMenuClick(event),
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
    const menuWidth = MENU_WIDTH;
    const gap = 4;

    setOpenMenu({
      kind: "collection",
      trackId,
      x: triggerRect.right - menuWidth,
      y: triggerRect.bottom + gap,
      flipY: triggerRect.top - gap,
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
          openedWithKeyboard={openMenu.openedWithKeyboard}
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
          flipY={openMenu.flipY}
          actions={[
            { label: "Add to Library", icon: "/add.svg", onSelect: () => addToLibrary(openMenu.trackId) },
            { label: "Credits", icon: "/credits.svg", onSelect: () => showTrackCredits(tracks.find(track => track.globalId === openMenu.trackId) ?? null) },
          ]}
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
      <h2 className="searchSectionTitle"><span id="searchTracksHeading">Tracks</span>{showAll("tracks", allTracks.length)}</h2>
      {!featuredTrack && <p className="searchSectionEmpty">{isSearching ? "Searching tracks…" : "No tracks found"}</p>}
      {featuredTrack && (
        <div id="searchResults">
          <div id="firstResult">
            {/* Keyed so a new top track gets its own element and glides up from the grid. */}
            <SearchResult
              key={featuredTrack.globalId}
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
          <h2><span id="searchArtistsHeading">Artists</span>{showAll("artists", artists.length)}</h2>
          {!artists.length && <p className="searchEntityEmpty">{isSearching ? "Searching artists…" : "No artists found"}</p>}
          {shownArtists.map(artist => <button type="button" className="searchEntity searchArtist" key={artist.id} data-glide={`artist:${artist.id}`} onPointerEnter={() => prefetchArtistPage(artist)} onFocus={() => prefetchArtistPage(artist)} onClick={() => onOpenEntity({ kind: "artist", artist })}>
            <ArtistPortrait key={artist.id} artist={artist} />
            <div className="searchEntityInfo"><strong>{artist.name}</strong><small>Artist</small></div>
          </button>)}
        </section>
        <section data-primary={order[0] === "albums"} style={sectionStyle("albums")} aria-labelledby="searchAlbumsHeading">
          <h2><span id="searchAlbumsHeading">Albums</span>{showAll("albums", albums.length)}</h2>
          {!albums.length && <p className="searchEntityEmpty">{isSearching ? "Searching albums…" : "No albums found"}</p>}
          {shownAlbums.map(album => {
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
