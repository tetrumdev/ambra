import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ProviderIcon } from "./ProviderIcon";
import type { Playlist, Track } from "../types/music";
import type { ListeningEntry } from "../hooks/useListeningHistory";
import { TrackArtwork } from "./TrackArtwork";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { isTrackAvailable, useServiceAvailability } from "../hooks/useServiceAvailability";
import type { EntityAction } from "./EntityView";
import "./HomeView.css";
import { useDiscover } from "../hooks/useDiscover";
import { reducedMotion } from "../utils/reducedMotion";

const monthMs = 30 * 24 * 60 * 60 * 1000;
const rowLimit = 12;

function HomeRow({
  title,
  empty,
  children,
  hasItems,
  loading = false,
}: {
  title: string;
  empty: string;
  children: ReactNode;
  hasItems: boolean;
  loading?: boolean;
}) {
  const row = useRef<HTMLUListElement>(null);
  const [scroll, setScroll] = useState({ left: false, right: false });
  const updateScroll = useCallback(() => {
    const element = row.current;
    const left = Boolean(element && element.scrollLeft > 1);
    const right = Boolean(
      element &&
      element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
    );
    setScroll((current) =>
      current.left === left && current.right === right
        ? current
        : { left, right },
    );
  }, []);
  useEffect(() => {
    updateScroll();
    if (!row.current) return;
    const observer = new ResizeObserver(updateScroll);
    observer.observe(row.current);
    return () => observer.disconnect();
  }, [children, updateScroll]);
  return (
    <section className="homeSection" aria-label={title} aria-busy={loading || undefined}>
      <div className="homeSectionHeader">
        <h2>{title}</h2>
        {hasItems && (
          <div className="homeRowControls">
            {([-1, 1] as const).map((direction) => (
              <button
                type="button"
                key={direction}
                aria-label={`${direction < 0 ? "Scroll left" : "Scroll right"}: ${title}`}
                disabled={direction < 0 ? !scroll.left : !scroll.right}
                onClick={() =>
                  row.current?.scrollBy({
                    left: direction * row.current.clientWidth * 0.8,
                    behavior: reducedMotion() ? "instant" : "smooth",
                  })
                }
              >
                <svg
                  viewBox="0 0 20 20"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d={direction < 0 ? "M12 5l-5 5 5 5" : "M8 5l5 5-5 5"} />
                </svg>
              </button>
            ))}
          </div>
        )}
      </div>
      {hasItems ? (
        <ul className="homeRow" role="list" ref={row} onScroll={updateScroll}>
          {children}
        </ul>
      ) : (
        <p className="homeEmpty" role="status">{empty}</p>
      )}
    </section>
  );
}

type OnAction = (action: EntityAction, tracks: Track[], id?: string) => void;

/** Like a track row: the card opens the playback menu, and only its play button plays at once. */
function SongCards({
  tracks,
  onAction,
}: {
  tracks: Track[];
  onAction: OnAction;
}) {
  const connected = useServiceAvailability();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  return (
    <>
      {tracks.map((track) => (
        <li className="homeCard" key={track.globalId} data-unavailable={!isTrackAvailable(track, connected) ? "true" : undefined}>
          <button
            className="homeCardButton"
            disabled={!isTrackAvailable(track, connected)}
            type="button"
            aria-haspopup="menu"
            aria-label={`Options for ${track.name} by ${track.artist}`}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              // Keyboard presses have no pointer position.
              setMenu({
                id: track.globalId,
                x: event.detail ? event.clientX : bounds.left,
                y: event.detail ? event.clientY : bounds.bottom,
              });
            }}
          >
            <div className="homeArtwork">
              <TrackArtwork track={track} alt="" />
              <span className="homeShade" aria-hidden="true" />
            </div>
            <span
              className="homeCardTitle"
              data-tooltip={track.name}
              data-tooltip-overflow=""
            >
              {track.name}
            </span>
            <span
              className="homeCardDetail"
              data-tooltip={track.artist}
              data-tooltip-overflow=""
            >
              {track.artist}
            </span>
          </button>
          <div className="homePlayArea"></div>
        </li>
      ))}
      {/* Portaled: a list can only hold items, and the row scrolls and clips. */}
      {menu &&
        createPortal(
          <TrackPlaybackMenu
            onClose={() => setMenu(null)}
            xPos={menu.x}
            yPos={menu.y}
            trackId={menu.id}
            playTrack={(id) => onAction("play", tracks, id)}
            playStandalone={(id) => onAction("standalone", tracks, id)}
            addToQueue={(id) =>
              onAction(
                "queue",
                tracks.filter((track) => track.globalId === id),
              )
            }
            playNext={(id) => onAction("next", tracks, id)}
          />,
          document.body,
        )}
    </>
  );
}

export function HomeView({
  entries,
  tracks,
  playlists,
  error,
  onAction,
  onSelectPlaylist,
  registerScrollElement,
}: {
  entries: ListeningEntry[];
  tracks: Track[];
  playlists: Playlist[];
  error: string | null;
  onAction: OnAction;
  onSelectPlaylist: (id: string) => void;
  registerScrollElement: (element: HTMLDivElement | null) => void;
}) {
  const discover = useDiscover(entries);
  const tracksById = useMemo(
    () => new Map(tracks.map((track) => [track.globalId, track])),
    [tracks],
  );
  const cutoff = Date.now() - monthMs;
  const ordered = useMemo(
    () => [...entries].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt),
    [entries],
  );
  const resolve = (entry: ListeningEntry) =>
    tracksById.get(entry.track.globalId) ?? entry.track;
  const recent = ordered
    .filter((entry) => entry.lastPlayedAt > cutoff)
    .slice(0, rowLimit)
    .map(resolve);
  const older = ordered
    .filter((entry) => entry.lastPlayedAt <= cutoff)
    .reverse()
    .slice(0, rowLimit)
    .map(resolve);

  return (
    <div
      className="libraryView homeView smoothScroll"
      ref={registerScrollElement}
    >
      <header className="homeHeader">
        <h1 className="libraryTitle">Welcome Back</h1>
      </header>
      {error && (
        <p className="homeError" role="alert">
          {error}
        </p>
      )}
      <HomeRow
        title="Recently played"
        empty="Play some music to start your listening history."
        hasItems={recent.length > 0}
      >
        <SongCards tracks={recent} onAction={onAction} />
      </HomeRow>
      <HomeRow
        title="Your playlists"
        empty="Create a playlist or connect a music service to see your playlists here."
        hasItems={playlists.length > 0}
      >
        {playlists.map((playlist) => {
          const artwork = playlist.trackIds
            .map((id) => tracksById.get(id))
            .filter((track): track is Track => Boolean(track))
            .slice(0, 4);
          const count = playlist.trackCount ?? playlist.trackIds.length;
          return (
            <li className="homeCard" key={playlist.id}>
              <button
                className="homeCardButton"
                type="button"
                onClick={() => onSelectPlaylist(playlist.id)}
              >
                <div
                  className="homeArtwork homePlaylistArtwork"
                  aria-hidden="true"
                >
                  {artwork.length > 0 ? (
                    <div className="playlistArtworkGrid">
                      {Array.from({ length: 4 }, (_, index) =>
                        artwork[index] ? (
                          <TrackArtwork
                            key={index}
                            track={artwork[index]}
                            alt=""
                          />
                        ) : (
                          <span key={index} />
                        ),
                      )}
                    </div>
                  ) : (
                    <span className="homePlaylistPlaceholder">♫</span>
                  )}
                </div>
                <span
                  className="homeCardTitle"
                  data-tooltip={playlist.name}
                  data-tooltip-overflow=""
                >
                  {playlist.name}
                </span>
                <span className="homeCardDetail">
                  <ProviderIcon
                    provider={playlist.provider ?? "local"}
                    label={playlist.provider ? undefined : "AMBRA"}
                  />{" "}
                  · {count} {count === 1 ? "song" : "songs"}
                </span>
              </button>
            </li>
          );
        })}
      </HomeRow>
      <HomeRow
        title="Haven’t played in a while"
        empty="Songs you last played over 30 days ago will appear here."
        hasItems={older.length > 0}
      >
        <SongCards tracks={older} onAction={onAction} />
      </HomeRow>
      <HomeRow
        title="Discover"
        empty={discover.message}
        hasItems={discover.tracks.length > 0}
        loading={discover.loading}
      >
        <SongCards tracks={discover.tracks} onAction={onAction} />
      </HomeRow>
    </div>
  );
}
