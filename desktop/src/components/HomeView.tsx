import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ProviderIcon } from "./ProviderIcon";
import type { Playlist, Track } from "../types/music";
import type { ListeningEntry } from "../hooks/useListeningHistory";
import { TrackArtwork } from "./TrackArtwork";
import "./HomeView.css";

const monthMs = 30 * 24 * 60 * 60 * 1000;
const rowLimit = 12;

function HomeRow({ title, empty, children, hasItems }: {
  title: string;
  empty: string;
  children: ReactNode;
  hasItems: boolean;
}) {
  const row = useRef<HTMLUListElement>(null);
  const [scroll, setScroll] = useState({ left: false, right: false });
  const updateScroll = useCallback(() => {
    const element = row.current;
    const left = Boolean(element && element.scrollLeft > 1);
    const right = Boolean(element && element.scrollLeft + element.clientWidth < element.scrollWidth - 1);
    setScroll(current => current.left === left && current.right === right ? current : { left, right });
  }, []);
  useEffect(() => {
    updateScroll();
    if (!row.current) return;
    const observer = new ResizeObserver(updateScroll);
    observer.observe(row.current);
    return () => observer.disconnect();
  }, [children, updateScroll]);
  return <section className="homeSection" aria-label={title}>
    <div className="homeSectionHeader">
      <h2>{title}</h2>
      {hasItems && <div className="homeRowControls">
        {([-1, 1] as const).map(direction => <button type="button" key={direction}
          aria-label={`${direction < 0 ? "Scroll left" : "Scroll right"}: ${title}`}
          disabled={direction < 0 ? !scroll.left : !scroll.right}
          onClick={() => row.current?.scrollBy({ left: direction * row.current.clientWidth * 0.8, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })}>
          <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d={direction < 0 ? "M12 5l-5 5 5 5" : "M8 5l5 5-5 5"} />
          </svg>
        </button>)}
      </div>}
    </div>
    {hasItems ? <ul className="homeRow" role="list" ref={row} onScroll={updateScroll}>{children}</ul> : <p className="homeEmpty">{empty}</p>}
  </section>;
}

function SongCards({ tracks, onPlay }: { tracks: Track[]; onPlay: (tracks: Track[], id: string) => void }) {
  return tracks.map(track => <li className="homeCard" key={track.globalId}>
    <button className="homeCardButton" type="button" aria-label={`Play ${track.name} by ${track.artist}`} onClick={() => onPlay(tracks, track.globalId)}>
      <div className="homeArtwork">
        <TrackArtwork track={track} alt="" />
        <span className="homePlay" aria-hidden="true"><img src="/Play.svg" alt="" /></span>
      </div>
      <span className="homeCardTitle" data-tooltip={track.name} data-tooltip-overflow="">{track.name}</span>
      <span className="homeCardDetail" data-tooltip={track.artist} data-tooltip-overflow="">{track.artist}</span>
    </button>
  </li>);
}

export function HomeView({ entries, tracks, playlists, error, onPlay, onSelectPlaylist, registerScrollElement }: {
  entries: ListeningEntry[];
  tracks: Track[];
  playlists: Playlist[];
  error: string | null;
  onPlay: (tracks: Track[], id: string) => void;
  onSelectPlaylist: (id: string) => void;
  registerScrollElement: (element: HTMLDivElement | null) => void;
}) {
  const tracksById = useMemo(() => new Map(tracks.map(track => [track.globalId, track])), [tracks]);
  const cutoff = Date.now() - monthMs;
  const ordered = useMemo(() => [...entries].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt), [entries]);
  const resolve = (entry: ListeningEntry) => tracksById.get(entry.track.globalId) ?? entry.track;
  const recent = ordered.filter(entry => entry.lastPlayedAt > cutoff).slice(0, rowLimit).map(resolve);
  const older = ordered.filter(entry => entry.lastPlayedAt <= cutoff).reverse().slice(0, rowLimit).map(resolve);

  return <div className="libraryView homeView smoothScroll" ref={registerScrollElement}>
    <header className="homeHeader"><h1 className="libraryTitle">Welcome Back</h1></header>
    {error && <p className="homeError" role="alert">{error}</p>}
    <HomeRow title="Recently played" empty="Play some music to start your listening history." hasItems={recent.length > 0}>
      <SongCards tracks={recent} onPlay={onPlay} />
    </HomeRow>
    <HomeRow title="Your playlists" empty="Create a playlist or connect a music service to see your playlists here." hasItems={playlists.length > 0}>
      {playlists.map(playlist => {
        const artwork = playlist.trackIds.map(id => tracksById.get(id)).filter((track): track is Track => Boolean(track)).slice(0, 4);
        const count = playlist.trackCount ?? playlist.trackIds.length;
        return <li className="homeCard" key={playlist.id}>
          <button className="homeCardButton" type="button" onClick={() => onSelectPlaylist(playlist.id)}>
            <div className="homeArtwork homePlaylistArtwork" aria-hidden="true">
              {artwork.length > 0 ? <div className="playlistArtworkGrid">
                {Array.from({ length: 4 }, (_, index) => artwork[index]
                  ? <TrackArtwork key={index} track={artwork[index]} alt="" /> : <span key={index} />)}
              </div> : <span className="homePlaylistPlaceholder">♫</span>}
            </div>
            <span className="homeCardTitle" data-tooltip={playlist.name} data-tooltip-overflow="">{playlist.name}</span>
            <span className="homeCardDetail"><ProviderIcon provider={playlist.provider ?? "local"} label={playlist.provider ? undefined : "AMBRA"} /> · {count} {count === 1 ? "song" : "songs"}</span>
          </button>
        </li>;
      })}
    </HomeRow>
    <HomeRow title="Haven’t played in a while" empty="Songs you last played over 30 days ago will appear here." hasItems={older.length > 0}>
      <SongCards tracks={older} onPlay={onPlay} />
    </HomeRow>
  </div>;
}
