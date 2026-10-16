import { memo, useEffect, useMemo, useState } from "react";
import {
  highestQualityAlbumArtwork,
  loadAlbumTracks,
  type ArtistProfile,
  type CatalogAlbum,
} from "../api/server";
import type { Track } from "../types/music";
import {
  entityKey,
  sortAlbumTracks,
  tracksForEntity,
  type BrowseEntity,
} from "../utils/browse";
import { AlbumArtwork } from "./AlbumArtwork";
import { TrackCollectionView } from "./TrackCollectionView";
import type { PlaylistMenuOptions } from "./TrackCollectionMenu";
import { ArtistView } from "./ArtistView";
import "./EntityView.css";

export type EntityPage = {
  tracks?: Track[];
  entire?: boolean;
  profile?: ArtistProfile;
  albums?: CatalogAlbum[];
  albumsLoaded?: boolean;
  nextOffset?: number | null;
  expandedPopular?: boolean;
  expandedBiography?: boolean;
};
export type EntityAction = "play" | "standalone" | "queue" | "next" | "shuffle";
export type EntityViewProps = {
  entity: BrowseEntity;
  cache: Map<string, EntityPage>;
  libraryTracks: Track[];
  onBack: () => void;
  onOpenEntity: (entity: BrowseEntity) => void;
  onAction: (action: EntityAction, tracks: Track[], id?: string) => void;
  onAddTrack: (track: Track) => void;
  rememberTracks: (tracks: Track[]) => void;
  playlistOptions: PlaylistMenuOptions;
  registerScrollElement: (element: HTMLDivElement | null) => void;
};
// Memoized: App rerenders on every playback tick, which must not rebuild this page.
export const EntityView = memo(function EntityView(props: EntityViewProps) {
  return props.entity.kind === "artist" ? (
    <ArtistView {...props} artist={props.entity.artist} />
  ) : (
    <AlbumView {...props} album={props.entity.album} />
  );
});
function AlbumView({
  album,
  ...props
}: EntityViewProps & { album: CatalogAlbum }) {
  const key = entityKey(props.entity);
  const cached = props.cache.get(key);
  const saved = useMemo(
    () => tracksForEntity(props.entity, props.libraryTracks),
    [props.entity, props.libraryTracks],
  );
  const savedTrackIds = useMemo(
    () => new Set(saved.map((track) => track.globalId)),
    [saved],
  );
  const [entire, setEntire] = useState(cached?.entire ?? !saved.length);
  const [catalogTracks, setCatalogTracks] = useState<Track[] | undefined>(
    cached?.tracks,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!entire || catalogTracks || album.provider === "local") {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void loadAlbumTracks(album, controller.signal)
      .then((tracks) => {
        if (!controller.signal.aborted)
          setCatalogTracks(sortAlbumTracks(tracks));
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [album.id, album.provider, entire, catalogTracks, attempt]);
  useEffect(() => {
    props.cache.set(key, { tracks: catalogTracks, entire });
    if (catalogTracks) props.rememberTracks(catalogTracks);
  }, [key, catalogTracks, entire, props.cache, props.rememberTracks]);
  const tracks =
    entire && album.provider !== "local" ? (catalogTracks ?? []) : saved;
  return (
    <TrackCollectionView
      className="entityView albumView"
      title={album.title}
      tracks={tracks}
      playlistOptions={props.playlistOptions}
      headerNavigation={
        <button type="button" className="browseBack" onClick={props.onBack}>
          Back
        </button>
      }
      headerArtwork={
        <AlbumArtwork
          src={album.imageUrl}
          title={album.title}
          resolveFull={() =>
            album.provider === "local"
              ? Promise.resolve(saved.find((track) => track.fullCover)?.fullCover ?? null)
              : highestQualityAlbumArtwork({
                  provider: album.provider,
                  albumId: album.id,
                  upc: album.upc,
                  coverUrl: album.imageUrl,
                }).then((artwork) => artwork?.url ?? null)
          }
        />
      }
      headerContent={
        <>
          <p className="entityByline">
            {album.artist}
            {album.releaseDate ? ` · ${album.releaseDate.slice(0, 4)}` : ""}
          </p>
          {album.provider !== "local" && (
            <nav className="browseScope" aria-label="Album songs">
              <button
                type="button"
                aria-current={!entire ? "page" : undefined}
                onClick={() => setEntire(false)}
              >
                Saved songs
              </button>
              <button
                type="button"
                aria-current={entire ? "page" : undefined}
                onClick={() => setEntire(true)}
              >
                Entire tracklist
              </button>
            </nav>
          )}
          {loading && (
            <p className="entityStatus" role="status">
              Loading tracks…
            </p>
          )}
          {error && (
            <p className="entityStatus" role="alert">
              {error}{" "}
              <button
                type="button"
                className="entityLink"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </button>
            </p>
          )}
          {!loading && !error && !tracks.length && (
            <p className="entityStatus">
              {entire
                ? "No tracks available."
                : "No saved songs from this album."}
            </p>
          )}
        </>
      }
      playbackActions={
        <button
          type="button"
          className="libraryShuffleBtn"
          disabled={!tracks.length}
          onClick={() => props.onAction("queue", tracks)}
        >
          <img src="/addToQueue.svg" alt="" />
          <span>ADD TO QUEUE</span>
        </button>
      }
      playTrack={(id) => props.onAction("play", tracks, id)}
      playStandalone={(id) => props.onAction("standalone", tracks, id)}
      addToQueue={(id) =>
        props.onAction(
          "queue",
          tracks.filter((track) => track.globalId === id),
        )
      }
      playNext={(id) => props.onAction("next", tracks, id)}
      shuffleCollection={() => props.onAction("shuffle", tracks)}
      addToLibrary={(id) => {
        const track = tracks.find((track) => track.globalId === id);
        if (track) props.onAddTrack(track);
      }}
      onOpenEntity={props.onOpenEntity}
      showTrackNumbers
      showArtwork={false}
      savedTrackIds={savedTrackIds}
      registerScrollElement={props.registerScrollElement}
    />
  );
}
