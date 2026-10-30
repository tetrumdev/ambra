import "./Sidebar.css";
import { ProviderIcon } from "./ProviderIcon";
import { useEffect, useRef, useState } from "react";
import type { Playlist } from "../types/music.ts";
import { PlaylistActions } from "./PlaylistActions";
import type { LibrarySection } from "./LibraryView";
import { librarySections } from "../utils/librarySections";
import { closeDialog, openDialog } from "../utils/dialogs";
import type { PlaylistServiceGroup } from "../hooks/useServicePlaylists";
import { musicProviderName } from "../utils/musicProviderName";
import { DropdownChevron } from "./DropdownChevron";
import { slideDetails } from "../utils/detailsMotion";
import type { PlaylistGroup } from "../utils/preferences";
import type { StreamingProvider } from "../api/server";
import { matchesShortcut } from "../utils/shortcuts";
import { moveSidebar } from "../utils/keyboardNav";
import { useStableCallback } from "../hooks/useStableCallback";

type SidebarProps = {
  onOpenHome: () => void;
  isHomeActive: boolean;
  onOpenSettings: () => void;
  isSettingsActive: boolean;
  onOpenLibrary: () => void;
  activeLibrarySection: LibrarySection | null;
  activePlaylistId: string | null;
  onOpenLibrarySection: (section: LibrarySection) => void;
  onCreatePlaylist: (name: string) => string | null;
  playlists: Playlist[];
  onSelectPlaylist: (playlistId: string) => void;
  onRenamePlaylist: (id: string, name: string) => boolean | Promise<boolean>;
  onDuplicatePlaylist: (playlist: Playlist) => void;
  onDeletePlaylist: (id: string) => boolean | Promise<boolean>;
  serviceGroups: PlaylistServiceGroup[];
  servicePlaylistVisibility: Record<StreamingProvider, boolean>;
  playlistGroups: Record<PlaylistGroup, boolean>;
  onTogglePlaylistGroup: (group: PlaylistGroup, expanded: boolean) => void;
};

export function Sidebar({
  onOpenHome,
  isHomeActive,
  onOpenSettings,
  isSettingsActive,
  onOpenLibrary,
  activeLibrarySection,
  activePlaylistId,
  onOpenLibrarySection,
  onCreatePlaylist,
  playlists,
  onSelectPlaylist,
  onRenamePlaylist,
  onDuplicatePlaylist,
  onDeletePlaylist,
  serviceGroups,
  servicePlaylistVisibility,
  playlistGroups,
  onTogglePlaylistGroup,
}: SidebarProps) {
  const [isCreatingPlaylist, setIsCreatingPlaylist] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [createError, setCreateError] = useState(false);
  const createDialog = useRef<HTMLDialogElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  // Narrows the sidebar to the playlists and services matching it; null while closed.
  const [filter, setFilter] = useState<string | null>(null);
  const query = filter?.trim().toLowerCase() ?? "";
  const matches = (text: string) => !query || text.toLowerCase().includes(query);
  const filterPlaylists = (group: string, items: Playlist[]) => matches(group) ? items : items.filter(playlist => matches(playlist.name));
  const ambraPlaylists = filterPlaylists("AMBRA", playlists);

  const handleFilterShortcut = useStableCallback((event: KeyboardEvent) => {
    if (!matchesShortcut(event, "filterSidebar") || sidebarRef.current?.closest("[inert]")) return;
    event.preventDefault();
    if (event.repeat) return;
    setFilter(current => current ?? "");
    requestAnimationFrame(() => { filterInput.current?.focus(); filterInput.current?.select(); });
  });
  useEffect(() => {
    window.addEventListener("keydown", handleFilterShortcut);
    return () => window.removeEventListener("keydown", handleFilterShortcut);
  }, [handleFilterShortcut]);

  // Picking something from the sidebar by keyboard hands the keyboard back to the page.
  function handleSidebarKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (event.key !== "Enter" || !target.matches(".sidebarBtn")) return;
    requestAnimationFrame(() => {
      if (document.activeElement === target) target.blur();
      setFilter(null);
    });
  }

  function handleFilterKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveSidebar(sidebarRef.current?.parentElement, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      // The best match: a playlist, else whatever page is left.
      const first = sidebarRef.current?.querySelector<HTMLElement>(".sidebarPlaylistName")
        ?? sidebarRef.current?.querySelector<HTMLElement>("#libraryContainer .sidebarBtn");
      first?.click();
      event.currentTarget.blur();
      setFilter(null);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.blur();
      setFilter(null);
    }
  }

  useEffect(() => {
    if (isCreatingPlaylist) openDialog(createDialog.current);
    else closeDialog(createDialog.current);
  }, [isCreatingPlaylist]);

  function cancelCreatingPlaylist() {
    setIsCreatingPlaylist(false);
    setCreateError(false);
  }

  function beginCreatingPlaylist() {
    setIsCreatingPlaylist(true);
    setNewPlaylistName("New Playlist");
    setCreateError(false);
  }

  return (
    <>
      <div id="sidebarMain" ref={sidebarRef} onKeyDown={handleSidebarKeyDown}>
        <div id="libraryContainer">
          {filter !== null && <input
            ref={filterInput}
            className="sidebarFilterInput"
            type="search"
            placeholder="Filter playlists"
            aria-label="Filter playlists and services"
            spellCheck={false}
            autoComplete="off"
            value={filter}
            onChange={event => setFilter(event.currentTarget.value)}
            onKeyDown={handleFilterKeyDown}
            onBlur={event => { if (!event.currentTarget.value.trim()) setFilter(null); }}
          />}
          {matches("Home") && <button
            type="button"
            onClick={onOpenHome}
            className="sidebarBtn sidebarLibraryButton sidebarHomeButton"
            aria-current={isHomeActive ? "page" : undefined}
          >
            Home
          </button>}
          {matches("My Library") && <button
            type="button"
            onClick={onOpenLibrary}
            className="sidebarBtn sidebarLibraryButton"
            aria-current={
              activeLibrarySection === "overview" ? "page" : undefined
            }
          >
            My Library
          </button>}
          {librarySections.some(({ label }) => matches(label)) && <nav className="sidebarLibrarySections" aria-label="Library sections">
            {librarySections.filter(({ label }) => matches(label)).map(({ id, label }) => (
              <button
                type="button"
                className="sidebarBtn sidebarLibraryButton"
                key={id}
                onClick={() => onOpenLibrarySection(id)}
                aria-current={activeLibrarySection === id ? "page" : undefined}
              >
                {label}
              </button>
            ))}
          </nav>}
          <div id="playlistContainer">
            {/* While filtering, every group with a match stays open, without changing what's remembered. */}
            {ambraPlaylists.length > 0 && <details className="sidebarPlaylistGroup playlistDropdown" open={query ? true : playlistGroups.ambra}
              onToggle={event => { if (!query) onTogglePlaylistGroup("ambra", event.currentTarget.open); }}>
              <summary onClick={slideDetails}><DropdownChevron />AMBRA ({playlists.length})</summary>
              <nav className="sidebarLibrarySections sidebarPlaylistItems" aria-label="AMBRA playlists">
            {ambraPlaylists.map((playlist) => (
              <div key={playlist.id} className="sidebarPlaylistRow">
                <button
                  type="button"
                  className="sidebarBtn sidebarLibraryButton sidebarPlaylistName"
                  data-tooltip={playlist.name}
                  data-tooltip-overflow=""
                  onClick={() => onSelectPlaylist(playlist.id)}
                  aria-current={
                    activePlaylistId === playlist.id ? "page" : undefined
                  }
                >
                  {playlist.name}
                </button>
                <PlaylistActions
                  playlist={playlist}
                  onRename={onRenamePlaylist}
                  onDelete={onDeletePlaylist}
                  actions={[{ label: "Duplicate Playlist", icon: "/duplicate.svg", onSelect: () => onDuplicatePlaylist(playlist) }]}
                />
              </div>
            ))}
              </nav>
            </details>}
            {(["spotify", "qobuz", "tidal"] as const).map(provider => {
              const group = serviceGroups.find(group => group.provider === provider);
              if (!group || !servicePlaylistVisibility[provider]) return null;
              const shown = filterPlaylists(musicProviderName(provider), group.playlists);
              if (query && !shown.length) return null;
              return <details className="sidebarPlaylistGroup playlistDropdown" key={provider} open={query ? true : playlistGroups[provider]}
                onToggle={event => { if (!query) onTogglePlaylistGroup(provider, event.currentTarget.open); }}>
                <summary onClick={slideDetails}><DropdownChevron /><ProviderIcon provider={provider} /> ({group.playlists.length})</summary>
                <nav className="sidebarLibrarySections sidebarPlaylistItems" aria-label={`${musicProviderName(provider)} playlists`}>
                {shown.map(playlist => <div key={playlist.id} className="sidebarPlaylistRow">
                  <button type="button" className="sidebarBtn sidebarLibraryButton sidebarPlaylistName" data-tooltip={playlist.name} data-tooltip-overflow="" onClick={() => onSelectPlaylist(playlist.id)} aria-current={activePlaylistId === playlist.id ? "page" : undefined}>{playlist.name}</button>
                  <PlaylistActions playlist={playlist} onRename={playlist.editable ? onRenamePlaylist : undefined} onDelete={playlist.editable ? onDeletePlaylist : undefined} actions={[{ label: "Duplicate Playlist", icon: "/duplicate.svg", onSelect: () => onDuplicatePlaylist(playlist) }]} />
                </div>)}
                {group.error && <p className="sidebarSyncMessage" role="alert">{group.error}</p>}
                </nav>
              </details>;
            })}
          </div>
        </div>
        <div className="sidebarFooter">
          <button type="button" onClick={beginCreatingPlaylist} id="createPlaylistBtn">Create Playlist</button>
          <button
            type="button"
            className="sidebarBtn sidebarLibraryButton sidebarSettingsButton"
            onClick={onOpenSettings}
            aria-current={isSettingsActive ? "page" : undefined}
          >
            <img src="/settings.svg" alt="Settings" width={22} height={22} />
          </button>
        </div>
      </div>
      <dialog
        ref={createDialog}
        className="playlistEditDialog"
        aria-label="Name playlist"
        onCancel={(event) => {
          event.preventDefault();
          cancelCreatingPlaylist();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="playlistEditCancel"
          onClick={cancelCreatingPlaylist}
        >
          Cancel
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const playlistId = onCreatePlaylist(newPlaylistName);
            if (!playlistId) {
              setCreateError(true);
              return;
            }
            setIsCreatingPlaylist(false);
            setCreateError(false);
            onSelectPlaylist(playlistId);
          }}
        >
          <div className="playlistEditContent">
            <h2>Name playlist</h2>
            <input
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              autoFocus
              aria-label="Playlist name"
              value={newPlaylistName}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setNewPlaylistName(event.target.value)}
            />
            {createError && (
              <p role="alert">Could not save this change. Please try again.</p>
            )}
          </div>
          <div className="playlistEditButtons">
            <button type="submit" disabled={!newPlaylistName.trim()}>
              Save
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
