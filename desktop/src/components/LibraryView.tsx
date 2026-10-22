import type { CatalogAlbum } from "../api/server";
import { entityProvider, type BrowseEntity } from "../utils/browse";
import { memo, useMemo, useRef, type ReactNode } from "react";
import { ArtistPortrait } from "./ArtistPortrait";
import { prefetchArtistPage } from "../utils/artistPage";
import {
  libraryAlbums,
  libraryArtists,
  librarySections,
  type LibraryAlbum,
  type LibraryArtist,
} from "../utils/librarySections";
import {
  TrackCollectionView,
  type TrackCollectionViewProps,
} from "./TrackCollectionView";
import { LibrarySourcesDialog } from "./LibrarySourcesDialog";
import { ArtworkImage } from "./ArtworkImage";
import { formatTotalDuration } from "../utils/totalDuration";
import { PerfProfiler } from "./PerfProfiler";
import { VirtualSpacer } from "./VirtualSpacer";
import { useVirtualWindow } from "../hooks/useVirtualWindow";

export type LibrarySection = "overview" | "artists" | "albums" | "tracks";

type LibraryViewProps = Omit<
  TrackCollectionViewProps,
  "title" | "removalLabel" | "headerContent" | "content" | "summary"
> & {
  section: LibrarySection;
  onSectionChange: (section: LibrarySection) => void;
  onRescanLocalMusic: () => Promise<number>;
};

const VIRTUALIZE_AFTER_ENTITIES = 80;

function VirtualEntityGrid<T extends { id: string }>({
  items,
  label,
  cacheKey,
  renderItem,
}: {
  items: T[];
  label: string;
  cacheKey: string;
  renderItem: (item: T, index: number) => ReactNode;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualWindow({
    count: items.length,
    enabled: items.length > VIRTUALIZE_AFTER_ENTITIES,
    probeRef: gridRef,
    probeIsContainer: true,
    // The real, responsive grid geometry replaces this before paint. Starting
    // with one column deliberately overestimates height and never under-renders.
    fallback: { rowHeight: 230, columns: 1, rowGap: 28 },
    cacheKey,
    overscanRows: 3,
  });

  return (
    <PerfProfiler id={cacheKey}>
      <div className="libraryEntityGrid" aria-label={label} role="list" ref={gridRef}>
        {virtual.topSpace > 0 && <VirtualSpacer position="top" height={virtual.topSpace} />}
        {items.slice(virtual.start, virtual.end).map((item, windowIndex) =>
          renderItem(item, virtual.start + windowIndex),
        )}
        {virtual.bottomSpace > 0 && <VirtualSpacer position="bottom" height={virtual.bottomSpace} />}
      </div>
    </PerfProfiler>
  );
}

const ArtistCard = memo(function ArtistCard({ artist, index, count, onOpenEntity }: {
  artist: LibraryArtist;
  onOpenEntity?: (entity: BrowseEntity) => void;
  index: number;
  count: number;
}) {
  const catalogArtist = { id: artist.id, provider: entityProvider(artist.id), name: artist.name, imageUrl: artist.imageUrl };
  return (
    <article
      className="libraryEntityCard"
      key={artist.id}
      role="listitem"
      aria-posinset={index + 1}
      aria-setsize={count}
      data-virtual-item=""
    >
      <button type="button" className="libraryEntityButton" onPointerEnter={() => prefetchArtistPage(catalogArtist)} onFocus={() => prefetchArtistPage(catalogArtist)} onClick={() => onOpenEntity?.({ kind: "artist", artist: catalogArtist })}>
      <ArtistPortrait artist={catalogArtist} />
      <h2 data-tooltip={artist.name} data-tooltip-overflow="">{artist.name}</h2>
      <p>
        {artist.albumCount} {artist.albumCount === 1 ? "album" : "albums"}
        {" · "}
        {artist.trackCount} {artist.trackCount === 1 ? "track" : "tracks"}
      </p>
      </button>
    </article>
  );
});

const AlbumCard = memo(function AlbumCard({ album, index, count, onOpenEntity }: {
  album: LibraryAlbum;
  onOpenEntity?: (entity: BrowseEntity) => void;
  index: number;
  count: number;
}) {
  return (
    <article
      className="libraryEntityCard"
      key={album.id}
      role="listitem"
      aria-posinset={index + 1}
      aria-setsize={count}
      data-virtual-item=""
    >
      <button type="button" className="libraryEntityButton" onClick={() => onOpenEntity?.({ kind: "album", album: { id: album.id, provider: entityProvider(album.id), title: album.name, artist: album.artist, imageUrl: album.cover, releaseDate: album.releaseYear } })}>
      <ArtworkImage
        className="libraryAlbumCover"
        src={album.cover}
        alt={`${album.name} album cover`}
        loading="lazy"
      />
      <h2 data-tooltip={album.name} data-tooltip-overflow="">{album.name}</h2>
      <p>
        {album.artist}
        {album.releaseYear ? ` · ${album.releaseYear}` : ""}
      </p>
      </button>
    </article>
  );
});

function ArtistSection({ artists, onOpenEntity }: { artists: LibraryArtist[]; onOpenEntity?: (entity: BrowseEntity) => void }) {
  return (
    <VirtualEntityGrid
      items={artists}
      label="Artists"
      cacheKey="artist-grid"
      renderItem={(artist, index) => (
        <ArtistCard key={artist.id} artist={artist} index={index} count={artists.length} onOpenEntity={onOpenEntity} />
      )}
    />
  );
}

function AlbumSection({ albums, onOpenEntity }: { albums: LibraryAlbum[]; onOpenEntity?: (entity: BrowseEntity) => void }) {
  return (
    <VirtualEntityGrid
      items={albums}
      label="Albums"
      cacheKey="album-grid"
      renderItem={(album, index) => (
        <AlbumCard key={album.id} album={album} index={index} count={albums.length} onOpenEntity={onOpenEntity} />
      )}
    />
  );
}

export function LibraryView({
  section,
  onSectionChange,
  onRescanLocalMusic,
  ...props
}: LibraryViewProps) {
  const artists = useMemo(() => libraryArtists(props.tracks), [props.tracks]);
  const albums = useMemo(() => libraryAlbums(props.tracks), [props.tracks]);
  if (section === "overview") {
    const duration = props.tracks.reduce((total, track) => total + track.durationSeconds, 0);
    const counts = { artists: artists.length, albums: albums.length, tracks: props.tracks.length };
    return (
      <div className="libraryView smoothScroll" ref={props.registerScrollElement}>
        <div className="libraryHeader">
          <h1 className="libraryTitle">My Library</h1>
          <LibrarySourcesDialog
            onRescanLocalMusic={onRescanLocalMusic}
          />
        </div>
        <nav className="libraryOverview" aria-label="Library sections">
          {librarySections.map(({ id, label }) => (
            <button type="button" className="libraryOverviewCard" key={id} onClick={() => onSectionChange(id)}>
              <span className="libraryOverviewTitle">{label}</span>
              <span className="libraryOverviewCount">{counts[id]}</span>
              <span className="libraryOverviewDetail">
                {id === "artists" ? "Artists in your library" : id === "albums" ? "Albums in your library" : `${formatTotalDuration(duration)} of music`}
              </span>
              <span className="libraryOverviewArrow" aria-hidden="true">→</span>
            </button>
          ))}
        </nav>
      </div>
    );
  }
  const content =
    section === "artists" ? (
      <ArtistSection artists={artists} onOpenEntity={props.onOpenEntity} />
    ) : section === "albums" ? (
      <AlbumSection albums={albums} onOpenEntity={props.onOpenEntity} />
    ) : undefined;

  return (
    <TrackCollectionView
      {...props}
      title={librarySections.find(item => item.id === section)!.label}
      headerContent={
        <LibrarySourcesDialog
          onRescanLocalMusic={onRescanLocalMusic}
        />
      }
      removalLabel="Remove from Library"
      showPlaybackActions={section !== "artists"}
      summary={
        section === "artists"
          ? { count: artists.length, unit: "artist", showDuration: false }
          : section === "albums"
            ? { count: albums.length, unit: "album" }
            : undefined
      }
      content={content}
    />
  );
}

export function CatalogAlbumGrid({ albums, onOpenEntity }: { albums: CatalogAlbum[]; onOpenEntity: (entity: BrowseEntity) => void }) {
  return <VirtualEntityGrid items={albums} label="Albums" cacheKey="catalog-album-grid" renderItem={(album, index) => <article className="libraryEntityCard" role="listitem" aria-posinset={index + 1} aria-setsize={albums.length} key={album.id} data-virtual-item="">
    <button type="button" className="libraryEntityButton" onClick={() => onOpenEntity({ kind: "album", album })}>
      <ArtworkImage className="libraryAlbumCover" src={album.imageUrl} alt={`${album.title} album cover`} loading="lazy" />
      <h2 data-tooltip={album.title} data-tooltip-overflow="">{album.title}</h2>
      {/* The version sits with the details, where a long title can't cut it off, so an instrumental edition isn't mistaken for a duplicate. */}
      <p>{album.artist}{album.releaseDate ? ` · ${album.releaseDate.slice(0, 4)}` : ""}{album.version && !album.title.toLowerCase().includes(album.version.toLowerCase()) ? ` · ${album.version}` : ""}</p>
    </button>
  </article>} />;
}
