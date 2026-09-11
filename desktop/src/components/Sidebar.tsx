import "./Sidebar.css";
import { useEffect, useRef, useState } from "react";
import type { Playlist } from "../types/music.ts";
import { PlaylistActions } from "./PlaylistActions";
import { librarySections, type LibrarySection } from "./LibraryView";

type SidebarProps = {
  onOpenLibrary: () => void;
  activeLibrarySection: LibrarySection | null;
  activePlaylistId: string | null;
  onOpenLibrarySection: (section: LibrarySection) => void;
  onCreatePlaylist: (name: string) => string | null;
  playlists: Playlist[];
  onSelectPlaylist: (playlistId: string) => void;
  onRenamePlaylist: (id: string, name: string) => boolean;
  onDeletePlaylist: (id: string) => boolean;
};

export function Sidebar({
  onOpenLibrary,
  activeLibrarySection,
  activePlaylistId,
  onOpenLibrarySection,
  onCreatePlaylist,
  playlists,
  onSelectPlaylist,
  onRenamePlaylist,
  onDeletePlaylist,
}: SidebarProps) {
  const [isCreatingPlaylist, setIsCreatingPlaylist] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [createError, setCreateError] = useState(false);
  const createDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (isCreatingPlaylist) createDialog.current?.showModal();
    else createDialog.current?.close();
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
      <div className="mainLogoContainer">
        <div className="mainLogo">
          <img src="/ambra.svg" id="logoImg" />
        </div>
      </div>
      <div id="libraryContainer">
        <button type="button" onClick={onOpenLibrary} className="sidebarBtn sidebarLibraryButton" aria-current={activeLibrarySection === "overview" ? "page" : undefined}>
          My Library
        </button>
        <nav className="sidebarLibrarySections" aria-label="Library sections">
          {librarySections.map(({ id, label }) => (
            <button type="button" className="sidebarBtn sidebarLibraryButton" key={id} onClick={() => onOpenLibrarySection(id)} aria-current={activeLibrarySection === id ? "page" : undefined}>{label}</button>
          ))}
        </nav>
        <div id="playlistContainer">
          {playlists.map((playlist) => (
            <div key={playlist.id} className="sidebarPlaylistRow">
              <button
                type="button"
                className="sidebarBtn sidebarPlaylistName"
                onClick={() => onSelectPlaylist(playlist.id)}
                aria-current={activePlaylistId === playlist.id ? "page" : undefined}
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
        </div>
        <button type="button" onClick={beginCreatingPlaylist} id="createPlaylistBtn">
          Create Playlist
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
