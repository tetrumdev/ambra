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
import { ArtworkImage } from "./ArtworkImage";
import { DropdownChevron } from "./DropdownChevron";
import { loadProviderRecommendations, type RecommendationMix, type StreamingProvider } from "../api/server";
import type { Playlist, Track } from "../types/music";
import type { ListeningEntry } from "../hooks/useListeningHistory";
import { TrackArtwork } from "./TrackArtwork";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { SongContextMenu, isKeyboardMenuClick, playSongOnDoubleClick, songMenuPosition, suppressSongClick } from "../utils/trackMenu";
import { isTrackAvailable, useServiceAvailability, useServiceStatus } from "../hooks/useServiceAvailability";
import type { EntityAction } from "./EntityView";
import "./HomeView.css";
import { useDiscover } from "../hooks/useDiscover";
import { useRecommendationRequest } from "../hooks/useRecommendationRequest";
import type { BrowseEntity } from "../utils/browse";
import { reducedMotion } from "../utils/reducedMotion";

const monthMs = 30 * 24 * 60 * 60 * 1000;
const rowLimit = 12;
const recommendationProviders = { spotify: "Spotify", tidal: "TIDAL", qobuz: "Qobuz" } satisfies Record<StreamingProvider, string>;
export type RecommendationSource = "ambra" | StreamingProvider;
const providers = Object.keys(recommendationProviders) as StreamingProvider[];
const playlistSources = ["ambra", ...providers] as const;

function HomeRow({
  title,
  empty,
  children,
  hasItems,
  loading = false,
}: {
  title: string;
  empty: string;
  children?: ReactNode;
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

function RecommendationCard({ title, imageUrl, onClick, detail }: {
  title: string;
  imageUrl: string | null;
  onClick: () => void;
  detail?: string;
}) {
  return (
    <li className="homeCard">
      <button type="button" className="homeCardButton" onClick={onClick}>
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

function ProviderHome({ provider, onOpenEntity }: {
  provider: StreamingProvider; onOpenEntity: (entity: BrowseEntity) => void;
}) {
  const load = useCallback((signal: AbortSignal) => loadProviderRecommendations(provider, signal), [provider]);
  const { value, error, retry } = useRecommendationRequest(load);
  const defaultSection = provider === "qobuz" ? "Your mixes" : "Made for you";
  const sections = new Map<string, RecommendationMix[]>();
  for (const mix of value?.mixes ?? []) {
    const title = mix.section || defaultSection;
    const section = sections.get(title);
    if (section) section.push(mix);
    else sections.set(title, [mix]);
  }
  const albums = (value?.albums ?? []).filter(album => album.provider === provider)
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.title.localeCompare(b.title));
  return (
    <>
      {!sections.size && <HomeRow
        title={defaultSection}
        empty={error ? `Could not load ${recommendationProviders[provider]} recommendations.`
          : value ? "Your personalized mixes will appear here when available." : "Loading recommendations…"}
        hasItems={false}
        loading={!value && !error}
      />}
      {[...sections].map(([title, mixes]) => (
        <HomeRow key={title} title={title} empty="" hasItems>
          {mixes.map(mix => (
            <RecommendationCard key={mix.id} title={mix.title} imageUrl={mix.imageUrl}
              onClick={() => onOpenEntity({ kind: "mix", mix: { ...mix, provider } })} />
          ))}
        </HomeRow>
      ))}
      {error && <button className="homeRetry" type="button" onClick={retry}>Retry recommendations</button>}
      {albums.length > 0 && (
        <HomeRow title={provider === "qobuz" ? "Release Watch" : "Recommended albums"} empty="" hasItems>
          {albums.map(album => (
            <RecommendationCard key={album.id} title={album.title} imageUrl={album.imageUrl}
              detail={album.artist} onClick={() => onOpenEntity({ kind: "album", album, fromRecommendations: true })} />
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

export function HomeView({ registerScrollElement, onOpenEntity, selectedSource, onSelectSource, ...props }: AmbraHomeProps & {
  registerScrollElement: (element: HTMLDivElement | null) => void;
  onOpenEntity: (entity: BrowseEntity) => void;
  selectedSource: RecommendationSource;
  onSelectSource: (source: RecommendationSource) => void;
}) {
  const connected = useServiceStatus();
  const source = selectedSource !== "ambra" && connected?.[selectedSource] ? selectedSource : "ambra";
  useEffect(() => {
    if (connected && selectedSource !== source) onSelectSource(source);
  }, [connected, selectedSource, source, onSelectSource]);

  return (
    <div className="libraryView homeView smoothScroll" ref={registerScrollElement}>
      <header className="homeHeader">
        <h1 className="libraryTitle">Home</h1>
        <div className="homeSource">
          <select aria-label="Recommendation source" value={source}
            onChange={event => onSelectSource(event.currentTarget.value as RecommendationSource)}>
            <option value="ambra">Ambra</option>
            {providers.filter(provider => connected?.[provider]).map(provider => (
              <option key={provider} value={provider}>{recommendationProviders[provider]}</option>
            ))}
          </select>
          <DropdownChevron />
        </div>
      </header>
      {source === "ambra" ? <AmbraHome {...props} /> : (
        <ProviderHome key={source} provider={source} onOpenEntity={onOpenEntity} />
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
      {playlistSources.map(source => {
        const group = playlists.filter(playlist => (playlist.provider ?? "ambra") === source);
        if (!group.length && (source !== "ambra" || playlists.length)) return null;
        return (
          <HomeRow key={source} title={source === "ambra" ? "Your playlists" : `${recommendationProviders[source]} playlists`}
            empty="Create a playlist or connect a music service to see your playlists here."
            hasItems={group.length > 0}>
            {group.map(playlist => {
              const artwork = playlist.trackIds
                .map(id => tracksById.get(id))
                .filter((track): track is Track => Boolean(track))
                .slice(0, 4);
              const count = playlist.trackCount ?? playlist.trackIds.length;
              return (
                <li className="homeCard" key={playlist.id}>
                  <button className="homeCardButton" type="button" onClick={() => onSelectPlaylist(playlist.id)}>
                    <div className="homeArtwork homePlaylistArtwork" aria-hidden="true">
                      {artwork.length > 0 ? (
                        <div className="playlistArtworkGrid">
                          {Array.from({ length: 4 }, (_, index) => artwork[index]
                            ? <TrackArtwork key={index} track={artwork[index]} alt="" />
                            : <span key={index} />)}
                        </div>
                      ) : <span className="homePlaylistPlaceholder">♫</span>}
                    </div>
                    <span className="homeCardTitle" data-tooltip={playlist.name} data-tooltip-overflow="">{playlist.name}</span>
                    <span className="homeCardDetail">{count} {count === 1 ? "song" : "songs"}</span>
                  </button>
                </li>
              );
            })}
          </HomeRow>
        );
      })}
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
