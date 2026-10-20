import "./TrackMenus.css";
import { ProviderIcon } from "./ProviderIcon";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Playlist } from "../types/music";
import { isUnmodifiedKey } from "../utils/keyboard";
import { useFadeOutOnUnmount } from "../hooks/useFadeOutOnUnmount";
import { DropdownChevron } from "./DropdownChevron";

/** Every track menu's width, wide enough that no action wraps. Keep TrackMenus.css in step. */
export const MENU_WIDTH = 220;

export type PlaylistMenuOptions = {
  playlists: Playlist[];
  onAdd: (playlistId: string, trackId: string) => boolean | Promise<boolean>;
  onCreate: (name: string, trackId: string) => boolean | Promise<boolean>;
};

export type TrackCollectionAction = {
  label: string;
  /** Only where the playback menu has the same item, so the two show the same icon. */
  icon?: string;
  onSelect: () => void;
};

type TrackCollectionMenuProps = {
  onClose: () => void;
  xPos: number;
  yPos: number;
  actions: TrackCollectionAction[];
  trackId: string;
  playlistOptions?: PlaylistMenuOptions;
  /** "above" opens upward from yPos, for menus anchored near the bottom of the window. */
  placement?: "below" | "above";
};

export function TrackCollectionMenu({ onClose, xPos, yPos, actions, trackId, playlistOptions, placement = "below" }: TrackCollectionMenuProps) {
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this song. Please try again.");
    } finally {
      setSaving(false);
    }
  }
  const panel = useRef<HTMLDivElement>(null);
  useFadeOutOnUnmount(panel);
  const [position, setPosition] = useState({ left: xPos, top: yPos });
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const reposition = () => {
      const { width, height } = element.getBoundingClientRect();
      const left = Math.max(4, Math.min(xPos, window.innerWidth - width - 4));
      const top = Math.max(4, Math.min(placement === "above" ? yPos - height : yPos, window.innerHeight - height - 4));
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
  }, [xPos, yPos, placement]);
  useEffect(() => { panel.current?.focus(); }, [choosingPlaylist]);
  const width = choosingPlaylist ? 260 : MENU_WIDTH;
  return (
    <div id="trackMenuBackdrop" onClick={onClose} onKeyDown={event => {
      if (isUnmodifiedKey(event, "Escape")) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
      <div ref={panel} id="trackCollectionMenu" tabIndex={-1} style={{ ...position, transformOrigin: placement === "above" ? "left bottom" : "left top", width, maxWidth: "calc(100vw - 8px)", maxHeight: "calc(100vh - 8px)" }} onClick={event => event.stopPropagation()}>
        {choosingPlaylist && playlistOptions ? <>
          <button type="button" className="menuItem menuBack" onClick={() => setChoosingPlaylist(false)}><DropdownChevron />Add to Playlist</button>
          <div className="playlistMenuList">
            {playlistOptions.playlists.length === 0 && <p>No playlists yet. Create one below.</p>}
            {([undefined, "spotify", "qobuz", "tidal"] as const).map(provider => {
              const playlists = playlistOptions.playlists.filter(playlist => playlist.provider === provider);
              if (!playlists.length) return null;
              return <details className="playlistMenuGroup playlistDropdown" key={provider ?? "ambra"} open>
                <summary><DropdownChevron /><ProviderIcon provider={provider ?? "local"} label={provider ? undefined : "AMBRA"} /></summary>
                {playlists.map(playlist => {
              const added = playlist.trackIds.includes(trackId);
              return <button type="button" className="menuItem" key={playlist.id} disabled={added || saving} onClick={() => {
                void save(() => playlistOptions.onAdd(playlist.id, trackId));
              }}>{playlist.name}{added ? " ✓" : ""}</button>;
                })}
              </details>;
            })}
          </div>
          <form className="playlistMenuCreate" onSubmit={event => {
            event.preventDefault();
            void save(() => playlistOptions.onCreate(name, trackId));
          }}>
            <input spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off" aria-label="New AMBRA playlist name" placeholder="New playlist" value={name} onChange={event => setName(event.target.value)} />
            <button type="submit" disabled={!name.trim() || saving}>{saving ? "Saving…" : "Create"}</button>
            {error && <span role="alert">{error}</span>}
          </form>
        </> : <>
        {actions.map(action => (
          <button type="button" key={action.label} className="menuItem" onClick={() => { action.onSelect(); onClose(); }}>
            {action.icon && <img className="menuIcon" src={action.icon} alt="" aria-hidden="true" />}
            {action.label}
          </button>
        ))}
        {playlistOptions && <button type="button" className="menuItem" onClick={() => setChoosingPlaylist(true)}>Add to Playlist</button>}
        </>}
      </div>
    </div>
  );
}
