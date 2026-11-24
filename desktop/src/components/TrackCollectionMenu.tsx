import "./TrackMenus.css";
import { ProviderIcon } from "./ProviderIcon";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Playlist, Track } from "../types/music";
import { isUnmodifiedKey } from "../utils/keyboard";
import { useFadeOutOnUnmount } from "../hooks/useFadeOutOnUnmount";
import { DropdownChevron } from "./DropdownChevron";
import { TrackMenuBackdrop } from "./TrackMenuBackdrop";
import { MENU_WIDTH, menuBounds } from "../utils/trackMenu";
import { isTrackAvailable, useServiceAvailability } from "../hooks/useServiceAvailability";
import { isDownloadable, isDownloadedOnServer, offlineSource, openDownloadDialog, removeLocalDownloads, removeServerDownloads } from "../utils/offlineDownloads";
import { serverOnline } from "../api/serverConnection";
import type { PlaylistGroup } from "../utils/preferences";

export type PlaylistMenuOptions = {
  playlists: Playlist[];
  onAdd: (playlistId: string, trackId: string) => boolean | Promise<boolean>;
  onCreate: (name: string, trackId: string) => boolean | Promise<boolean>;
  /** Adds several songs at once, in order, e.g. a whole album. */
  onAddTracks: (playlistId: string, tracks: Track[]) => boolean | Promise<boolean>;
  onCreateWithTracks: (name: string, tracks: Track[]) => boolean | Promise<boolean>;
  /** Which groups show expanded, remembered between pickers. */
  groups: Record<PlaylistGroup, boolean>;
  onToggleGroup: (group: PlaylistGroup, expanded: boolean) => void;
};

export type TrackCollectionAction = {
  id?: string;
  label: string;
  icon: string;
  disabled?: boolean;
  /** Still offered when the song's service is signed out, e.g. removing it. */
  whenUnavailable?: boolean;
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
  /** Where a downward menu opens upward from instead, when it would run into the player bar. */
  flipY?: number;
  /** Songs a collection menu (no single song) adds to a playlist; null while they load. */
  tracks?: Track[] | null;
  /** The trigger already says Add to Playlist, so open its picker directly. */
  startWithPlaylistPicker?: boolean;
  returnFocusTo?: HTMLElement;
  instant?: boolean;
  /** As wide as its labels, for a short menu opened at the cursor. */
  fitContent?: boolean;
  /** False for a playback-only menu whose song's other menu already offers downloads. */
  downloads?: boolean;
};

export function TrackCollectionMenu({ onClose, xPos, yPos, actions, trackId, playlistOptions, placement = "below", flipY, tracks, startWithPlaylistPicker = false, returnFocusTo, instant = false, downloads = true, fitContent = false }: TrackCollectionMenuProps) {
  const collection = tracks !== undefined;
  const connected = useServiceAvailability();
  const available = collection || isTrackAvailable(trackId, connected);
  if (!available) { actions = actions.filter(action => action.whenUnavailable); playlistOptions = undefined; }
  // Every song's edit menu offers a download; collection menus (no song) bring their own.
  if (downloads && available && trackId && isDownloadable(trackId)) {
    actions = [...actions, { label: "Download", icon: "/download.svg", onSelect: () => openDownloadDialog([trackId], "this song") }];
  }
  if (downloads && trackId && offlineSource(trackId)) {
    actions = [...actions, { label: "Remove Download", icon: "/delete.svg", whenUnavailable: true, onSelect: () => void removeLocalDownloads([trackId]) }];
  }
  if (downloads && trackId && isDownloadedOnServer(trackId) && serverOnline) {
    actions = [...actions, { label: "Remove from Server Downloads", icon: "/delete.svg", whenUnavailable: true, onSelect: () => void removeServerDownloads([trackId]) }];
  }
  const [choosingPlaylist, setChoosingPlaylist] = useState(startWithPlaylistPicker);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  async function save(action: () => boolean | Promise<boolean>) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (await action()) {
        if (panel.current) onClose();
      } else setError("Could not save this playlist. Please try again.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this song. Please try again.");
    } finally {
      setSaving(false);
    }
  }
  useFadeOutOnUnmount(panel, !instant);
  const [position, setPosition] = useState({ left: xPos, top: yPos, above: placement === "above" });
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const reposition = () => {
      const { width, height } = element.getBoundingClientRect();
      const bounds = menuBounds(element);
      // A menu opened at the cursor turns to its left at the view's edge; one already lined up
      // with its trigger fits, and a wider playlist chooser only shifts in.
      const turnWidth = Math.min(MENU_WIDTH, element.offsetWidth || width);
      const turn = xPos + turnWidth > bounds.right && xPos - turnWidth >= bounds.left;
      const left = Math.max(bounds.left, Math.min(turn ? xPos - turnWidth : xPos, bounds.right - width));
      // Only the menu's natural size decides the flip, so its open/close scale never flips it back.
      const naturalHeight = element.offsetHeight || height;
      const bottom = bounds.bottom;
      const above = placement === "above"
        || (flipY !== undefined && yPos + naturalHeight > bottom && flipY - naturalHeight >= 4);
      const top = Math.max(4, Math.min(above ? (placement === "above" ? yPos : flipY!) - naturalHeight : yPos, window.innerHeight - naturalHeight - 4));
      setPosition(current => current.left === left && current.top === top && current.above === above ? current : { left, top, above });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(element);
    window.addEventListener("resize", reposition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
    };
  }, [xPos, yPos, placement, flipY, instant]);
  useEffect(() => { panel.current?.focus(); }, [choosingPlaylist]);
  useEffect(() => () => {
    if (returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
  }, [returnFocusTo]);
  const width = choosingPlaylist ? 260 : fitContent ? "max-content" : MENU_WIDTH;
  return (
    <TrackMenuBackdrop song={Boolean(trackId)} onClose={onClose} onKeyDown={event => {
      if (isUnmodifiedKey(event, "Escape")) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
      <div ref={panel} id="trackCollectionMenu" tabIndex={-1} style={{
        left: position.left, top: position.top, transformOrigin: position.above ? "left bottom" : "left top",
        width, maxWidth: "calc(100vw - 8px)", maxHeight: "calc(100vh - 8px)", animation: instant ? "none" : undefined,
      }} onClick={event => event.stopPropagation()}>
        {choosingPlaylist && playlistOptions ? <>
          <button type="button" className="menuItem menuBack" onClick={startWithPlaylistPicker ? onClose : () => setChoosingPlaylist(false)}><DropdownChevron />Add to Playlist</button>
          <div className="playlistMenuList">
            {playlistOptions.playlists.length === 0 && <p>No playlists yet. Create one below.</p>}
            {([undefined, "spotify", "qobuz", "tidal"] as const).map(provider => {
              const playlists = playlistOptions.playlists.filter(playlist => playlist.provider === provider);
              if (!playlists.length) return null;
              return <details className="playlistMenuGroup playlistDropdown" key={provider ?? "ambra"}
                open={playlistOptions.groups[provider ?? "ambra"]} onToggle={event => playlistOptions.onToggleGroup(provider ?? "ambra", event.currentTarget.open)}>
                <summary><DropdownChevron /><ProviderIcon provider={provider ?? "local"} label={provider ? undefined : "AMBRA"} /></summary>
                {playlists.map(playlist => {
              const added = collection
                ? Boolean(tracks?.length) && tracks!.every(track => playlist.trackIds.includes(track.globalId))
                : playlist.trackIds.includes(trackId);
              return <button type="button" className="menuItem" key={playlist.id} disabled={added || saving || (collection && !tracks?.length)} onClick={() => {
                void save(() => collection ? playlistOptions.onAddTracks(playlist.id, tracks ?? []) : playlistOptions.onAdd(playlist.id, trackId));
              }}>{playlist.name}{added ? " ✓" : ""}</button>;
                })}
              </details>;
            })}
          </div>
          <form className="playlistMenuCreate" onSubmit={event => {
            event.preventDefault();
            void save(() => collection ? playlistOptions.onCreateWithTracks(name, tracks ?? []) : playlistOptions.onCreate(name, trackId));
          }}>
            <input spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off" aria-label="New AMBRA playlist name" placeholder="New playlist" value={name} onChange={event => setName(event.target.value)} />
            <button type="submit" disabled={!name.trim() || saving || (collection && !tracks?.length)}>{saving ? "Saving…" : "Create"}</button>
            {error && <span role="alert">{error}</span>}
          </form>
        </> : <>
        {actions.map(action => (
          <button type="button" key={action.id ?? action.label} className="menuItem" disabled={action.disabled} onClick={() => { action.onSelect(); onClose(); }}>
            <img className="menuIcon" src={action.icon} alt="" aria-hidden="true" />
            <span className="menuItemLabel">{action.label}</span>
          </button>
        ))}
        {playlistOptions && <button type="button" className="menuItem" disabled={collection && !tracks?.length} onClick={() => setChoosingPlaylist(true)}><img className="menuIcon" src="/playlist-add.svg" alt="" aria-hidden="true" />Add to Playlist</button>}
        </>}
      </div>
    </TrackMenuBackdrop>
  );
}
