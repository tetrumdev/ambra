import "./Sidebar.css";
import { useEffect, useRef, useState } from "react";
import type { Playlist } from "../types/music.ts";
import { PlaylistActions } from "./PlaylistActions";
import { librarySections, type LibrarySection } from "./LibraryView";
import { closeDialog, openDialog } from "../utils/dialogs";
import type { PlaylistServiceGroup } from "../hooks/useServicePlaylists";
import { musicProviderName } from "../utils/musicProviderName";
import { DropdownChevron } from "./DropdownChevron";
import type { PlaylistGroup } from "../utils/preferences";
import type { StreamingProvider } from "../api/server";

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
  onRenamePlaylist: (id: string, name: string) => boolean;
  onDeletePlaylist: (id: string) => boolean;
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
      <div id="sidebarMain">
        <div id="libraryContainer">
          <button
            type="button"
            onClick={onOpenHome}
            className="sidebarBtn sidebarLibraryButton sidebarHomeButton"
            aria-current={isHomeActive ? "page" : undefined}
          >
            Home
          </button>
          <button
            type="button"
            onClick={onOpenLibrary}
            className="sidebarBtn sidebarLibraryButton"
            aria-current={
              activeLibrarySection === "overview" ? "page" : undefined
            }
          >
            My Library
          </button>
          <nav className="sidebarLibrarySections" aria-label="Library sections">
            {librarySections.map(({ id, label }) => (
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
          </nav>
          <div id="playlistContainer">
            <details className="sidebarPlaylistGroup playlistDropdown" open={playlistGroups.ambra} onToggle={event => onTogglePlaylistGroup("ambra", event.currentTarget.open)}>
              <summary><DropdownChevron />AMBRA ({playlists.length})</summary>
              <nav className="sidebarLibrarySections sidebarPlaylistItems" aria-label="AMBRA playlists">
            {playlists.map((playlist) => (
              <div key={playlist.id} className="sidebarPlaylistRow">
                <button
                  type="button"
                  className="sidebarBtn sidebarLibraryButton sidebarPlaylistName"
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
                />
              </div>
            ))}
              </nav>
            </details>
            {(["spotify", "qobuz", "tidal"] as const).map(provider => {
              const group = serviceGroups.find(group => group.provider === provider);
              if (!group || !servicePlaylistVisibility[provider]) return null;
              return <details className="sidebarPlaylistGroup playlistDropdown" key={provider} open={playlistGroups[provider]} onToggle={event => onTogglePlaylistGroup(provider, event.currentTarget.open)}>
                <summary><DropdownChevron />{musicProviderName(provider)} ({group.playlists.length})</summary>
                <nav className="sidebarLibrarySections sidebarPlaylistItems" aria-label={`${musicProviderName(provider)} playlists`}>
                {group.playlists.map(playlist => <div key={playlist.id} className="sidebarPlaylistRow">
                  <button type="button" className="sidebarBtn sidebarLibraryButton sidebarPlaylistName" onClick={() => onSelectPlaylist(playlist.id)} aria-current={activePlaylistId === playlist.id ? "page" : undefined}>{playlist.name}</button>
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
