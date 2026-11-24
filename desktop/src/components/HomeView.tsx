import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ProviderIcon } from "./ProviderIcon";
import { ArtworkImage } from "./ArtworkImage";
import { DropdownChevron } from "./DropdownChevron";
import {
  loadProviderRecommendations, loadRecommendationMix,
  type CatalogAlbum, type RecommendationMix, type StreamingProvider,
} from "../api/server";
import type { Playlist, Track } from "../types/music";
import type { ListeningEntry } from "../hooks/useListeningHistory";
import { TrackArtwork } from "./TrackArtwork";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { SongContextMenu, isKeyboardMenuClick, playSongOnDoubleClick, songMenuPosition, suppressSongClick } from "../utils/trackMenu";
import { isTrackAvailable, useServiceAvailability, useServiceStatus } from "../hooks/useServiceAvailability";
import type { EntityAction } from "./EntityView";
import "./HomeView.css";
import { useDiscover } from "../hooks/useDiscover";
import { reducedMotion } from "../utils/reducedMotion";

const monthMs = 30 * 24 * 60 * 60 * 1000;
const rowLimit = 12;
const recommendationProviders = { spotify: "Spotify", tidal: "TIDAL", qobuz: "Qobuz" } satisfies Record<StreamingProvider, string>;
type RecommendationSource = "ambra" | StreamingProvider;

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

/** Song cards offer the same playback actions as track rows. */
function SongCards({
  tracks,
  onAction,
}: {
  tracks: Track[];
  onAction: OnAction;
}) {
  const connected = useServiceAvailability();
  const combinedMenu = useContext(SongContextMenu);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; openedWithKeyboard: boolean; instant?: boolean } | null>(
    null,
  );
  useEffect(() => setMenu(null), [combinedMenu]);
  return (
    <>
      {tracks.map((track) => (
        <li className="homeCard" key={track.globalId} data-unavailable={!isTrackAvailable(track, connected) ? "true" : undefined}
          onClickCapture={combinedMenu ? suppressSongClick : undefined}
          onContextMenu={combinedMenu && isTrackAvailable(track, connected) ? event =>
            setMenu({ id: track.globalId, ...songMenuPosition(event), openedWithKeyboard: false }) : undefined}
          onDoubleClick={combinedMenu && isTrackAvailable(track, connected) ? event =>
            playSongOnDoubleClick(event, () => onAction("play", tracks, track.globalId)) : undefined}>
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
                openedWithKeyboard: isKeyboardMenuClick(event),
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
            openedWithKeyboard={menu.openedWithKeyboard}
            instant={menu.instant}
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

function useRecommendationRequest<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [result, setResult] = useState<{ value?: T; error?: boolean }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(value => {
      if (!controller.signal.aborted) setResult({ value });
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ error: true });
    });
    return () => controller.abort();
  }, [load, attempt]);
  return { ...result, retry: () => { setResult({}); setAttempt(attempt + 1); } };
}

function RecommendationCard({ title, imageUrl, selected, onClick, detail }: {
  title: string;
  imageUrl: string | null;
  selected?: boolean;
  onClick: () => void;
  detail?: string;
}) {
  return (
    <li className="homeCard">
      <button type="button" className="homeCardButton" onClick={onClick} aria-pressed={selected}>
        <div className="homeArtwork">
          {imageUrl
            ? <ArtworkImage src={imageUrl} alt="" />
            : <span className="homePlaylistPlaceholder" aria-hidden="true">♫</span>}
        </div>
        <span className="homeCardTitle" data-tooltip={title} data-tooltip-overflow="">{title}</span>
        {detail && <span className="homeCardDetail">{detail}</span>}
      </button>
    </li>
  );
}

function RecommendationMixRow({ mix, provider, onAction }: {
  mix: RecommendationMix; provider: StreamingProvider; onAction: OnAction;
}) {
  const load = useCallback((signal: AbortSignal) => loadRecommendationMix(provider, mix.id, signal), [provider, mix.id]);
  const { value, error, retry } = useRecommendationRequest(load);
  return (
    <>
      <HomeRow title={mix.title}
        empty={error ? "Could not load this mix." : value ? "No playable songs are available yet." : "Loading songs…"}
        hasItems={Boolean(value?.length)} loading={!value && !error}>
        <SongCards tracks={value ?? []} onAction={onAction} />
      </HomeRow>
      {error && <button className="homeRetry" type="button" onClick={retry}>Retry mix</button>}
    </>
  );
}

function ProviderHome({ provider, onAction, onSelectAlbum }: {
  provider: StreamingProvider; onAction: OnAction; onSelectAlbum: (album: CatalogAlbum) => void;
}) {
  const load = useCallback((signal: AbortSignal) => loadProviderRecommendations(provider, signal), [provider]);
  const { value, error, retry } = useRecommendationRequest(load);
  const [mix, setMix] = useState<RecommendationMix | null>(null);
  return (
    <>
      <HomeRow
        title={provider === "qobuz" ? "Your mixes" : "Made for you"}
        empty={error ? `Could not load ${recommendationProviders[provider]} recommendations.`
          : value ? "Your personalized mixes will appear here when available." : "Loading recommendations…"}
        hasItems={Boolean(value?.mixes.length)}
        loading={!value && !error}
      >
        {value?.mixes.map(item => (
          <RecommendationCard key={item.id} title={item.title} imageUrl={item.imageUrl}
            selected={mix?.id === item.id} onClick={() => setMix(mix?.id === item.id ? null : item)} />
        ))}
      </HomeRow>
      {error && <button className="homeRetry" type="button" onClick={retry}>Retry recommendations</button>}
      {mix && <RecommendationMixRow key={mix.id} mix={mix} provider={provider} onAction={onAction} />}
      {Boolean(value?.albums.length) && (
        <HomeRow title="Release Watch" empty="" hasItems>
          {value?.albums.filter(album => album.provider === provider).map(album => (
            <RecommendationCard key={album.id} title={album.title} imageUrl={album.imageUrl}
              detail={album.artist} onClick={() => onSelectAlbum(album)} />
          ))}
        </HomeRow>
      )}
    </>
  );
}

type AmbraHomeProps = {
  entries: ListeningEntry[];
  tracks: Track[];
  playlists: Playlist[];
  error: string | null;
  onAction: OnAction;
  onSelectPlaylist: (id: string) => void;
};

export function HomeView({ registerScrollElement, onSelectAlbum, ...props }: AmbraHomeProps & {
  registerScrollElement: (element: HTMLDivElement | null) => void;
  onSelectAlbum: (album: CatalogAlbum) => void;
}) {
  const connected = useServiceStatus();
  const [selected, setSelected] = useState<RecommendationSource>("ambra");
  const source = selected !== "ambra" && connected?.[selected] ? selected : "ambra";
  useEffect(() => {
    if (selected !== source) setSelected(source);
  }, [selected, source]);

  return (
    <div className="libraryView homeView smoothScroll" ref={registerScrollElement}>
      <header className="homeHeader">
        <h1 className="libraryTitle">Home</h1>
        <div className="homeSource">
          <select aria-label="Recommendation source" value={source}
            onChange={event => setSelected(event.currentTarget.value as RecommendationSource)}>
            <option value="ambra">Ambra</option>
            {(Object.keys(recommendationProviders) as StreamingProvider[]).filter(provider => connected?.[provider]).map(provider => (
              <option key={provider} value={provider}>{recommendationProviders[provider]}</option>
            ))}
          </select>
          <DropdownChevron />
        </div>
      </header>
      {source === "ambra" ? <AmbraHome {...props} /> : (
        <ProviderHome key={source} provider={source} onAction={props.onAction} onSelectAlbum={onSelectAlbum} />
      )}
    </div>
  );
}

function AmbraHome({ entries, tracks, playlists, error, onAction, onSelectPlaylist }: AmbraHomeProps) {
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
    <>
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
    </>
  );
}
