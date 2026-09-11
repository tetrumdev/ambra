import "./TrackMenus.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Playlist } from "../types/music";

export type PlaylistMenuOptions = {
  playlists: Playlist[];
  onAdd: (playlistId: string, trackId: string) => boolean | Promise<boolean>;
  onCreate: (name: string, trackId: string) => boolean | Promise<boolean>;
};

export type TrackCollectionAction = {
  label: string;
  onSelect: () => void;
};

type TrackCollectionMenuProps = {
  onClose: () => void;
  xPos: number;
  yPos: number;
  actions: TrackCollectionAction[];
  trackId: string;
  playlistOptions?: PlaylistMenuOptions;
};

export function TrackCollectionMenu({ onClose, xPos, yPos, actions, trackId, playlistOptions }: TrackCollectionMenuProps) {
  const [choosingPlaylist, setChoosingPlaylist] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(action: () => boolean | Promise<boolean>) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (await action()) onClose();
      else setError("Could not save this playlist. Please try again.");
    } catch {
      setError("Could not prepare this song. Please try again.");
    } finally {
      setSaving(false);
    }
  }
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: xPos, top: yPos });
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const reposition = () => {
      const { width, height } = element.getBoundingClientRect();
      const left = Math.max(4, Math.min(xPos, window.innerWidth - width - 4));
      const top = Math.max(4, Math.min(yPos, window.innerHeight - height - 4));
      setPosition(current => current.left === left && current.top === top ? current : { left, top });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(element);
    window.addEventListener("resize", reposition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
    };
  }, [xPos, yPos]);
  useEffect(() => { panel.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [choosingPlaylist]);
  const width = choosingPlaylist ? 260 : 180;
  return (
    <div id="trackMenuBackdrop" onClick={onClose} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
      <div ref={panel} id="trackCollectionMenu" style={{ ...position, width, maxWidth: "calc(100vw - 8px)", maxHeight: "calc(100vh - 8px)" }} onClick={event => event.stopPropagation()}>
        {choosingPlaylist && playlistOptions ? <>
          <button type="button" className="menuItem" onClick={() => setChoosingPlaylist(false)}>← Back</button>
          <div className="playlistMenuList">
            {playlistOptions.playlists.length === 0 && <p>No playlists yet. Create one below.</p>}
            {playlistOptions.playlists.map(playlist => {
              const added = playlist.trackIds.includes(trackId);
              return <button type="button" className="menuItem" key={playlist.id} disabled={added || saving} onClick={() => {
                void save(() => playlistOptions.onAdd(playlist.id, trackId));
              }}>{playlist.name}{added ? " ✓" : ""}</button>;
            })}
          </div>
          <form className="playlistMenuCreate" onSubmit={event => {
            event.preventDefault();
            void save(() => playlistOptions.onCreate(name, trackId));
          }}>
            <input aria-label="New playlist name" placeholder="New playlist name" value={name} onChange={event => setName(event.target.value)} />
            <button type="submit" disabled={!name.trim() || saving}>{saving ? "Saving…" : "Create & add"}</button>
            {error && <span role="alert">{error}</span>}
          </form>
        </> : <>
        {actions.map(action => (
          <button type="button" key={action.label} className="menuItem" onClick={() => { action.onSelect(); onClose(); }}>
            {action.label}
          </button>
        ))}
        {playlistOptions && <button type="button" className="menuItem" onClick={() => setChoosingPlaylist(true)}>Add to Playlist</button>}
        </>}
      </div>
    </div>
  );
}
