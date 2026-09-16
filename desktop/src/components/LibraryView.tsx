import { useMemo } from "react";
import { ArtistPortrait } from "./ArtistPortrait";
import {
  libraryAlbums,
  libraryArtists,
  type LibraryAlbum,
  type LibraryArtist,
} from "../utils/librarySections";
import {
  TrackCollectionView,
  type TrackCollectionViewProps,
} from "./TrackCollectionView";
import { LibrarySourcesDialog } from "./LibrarySourcesDialog";

export type LibrarySection = "overview" | "artists" | "albums" | "tracks";

type LibraryViewProps = Omit<
  TrackCollectionViewProps,
  "title" | "removalLabel" | "headerContent" | "content" | "summary"
> & {
  section: LibrarySection;
  onSectionChange: (section: LibrarySection) => void;
  onRescanLocalMusic: () => Promise<number>;
  onServiceConnected: () => void;
};

export const librarySections: Array<{ id: Exclude<LibrarySection, "overview">; label: string }> = [
  { id: "artists", label: "Artists" },
  { id: "albums", label: "Albums" },
  { id: "tracks", label: "Tracks" },
];

function ArtistSection({ artists }: { artists: LibraryArtist[] }) {
  return (
    <div className="libraryEntityGrid" aria-label="Artists">
      {artists.map((artist) => (
        <article className="libraryEntityCard" key={artist.id}>
          <ArtistPortrait name={artist.name} fallback={artist.imageUrl} />
          <h2>{artist.name}</h2>
          <p>
            {artist.albumCount} {artist.albumCount === 1 ? "album" : "albums"}
            {" · "}
            {artist.trackCount} {artist.trackCount === 1 ? "track" : "tracks"}
          </p>
        </article>
      ))}
    </div>
  );
}

function AlbumSection({ albums }: { albums: LibraryAlbum[] }) {
  return (
    <div className="libraryEntityGrid" aria-label="Albums">
      {albums.map((album) => (
        <article className="libraryEntityCard" key={album.id}>
          <img
            className="libraryAlbumCover"
            src={album.cover}
            alt={`${album.name} album cover`}
            loading="lazy"
          />
          <h2>{album.name}</h2>
          <p>
            {album.artist}
            {album.releaseYear ? ` · ${album.releaseYear}` : ""}
          </p>
        </article>
      ))}
    </div>
  );
}

export function LibraryView({
  section,
  onSectionChange,
  onRescanLocalMusic,
  onServiceConnected,
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
            onServiceConnected={onServiceConnected}
          />
        </div>
        <nav className="libraryOverview" aria-label="Library sections">
          {librarySections.map(({ id, label }) => (
            <button type="button" className="libraryOverviewCard" key={id} onClick={() => onSectionChange(id)}>
              <span className="libraryOverviewTitle">{label}</span>
              <span className="libraryOverviewCount">{counts[id]}</span>
              <span className="libraryOverviewDetail">
                {id === "artists" ? "Artists in your library" : id === "albums" ? "Albums in your library" : `${Math.floor(duration / 3600)} hr ${Math.floor(duration % 3600 / 60)} min of music`}
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
      <ArtistSection artists={artists} />
    ) : section === "albums" ? (
      <AlbumSection albums={albums} />
    ) : undefined;

  return (
    <TrackCollectionView
      {...props}
      title={librarySections.find(item => item.id === section)!.label}
      headerContent={
        <LibrarySourcesDialog
          onRescanLocalMusic={onRescanLocalMusic}
          onServiceConnected={onServiceConnected}
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
