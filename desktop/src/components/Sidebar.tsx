import "./Sidebar.css";
import type { Playlist } from "../types/music.ts";
import { PlaylistActions } from "./PlaylistActions";
import { librarySections, type LibrarySection } from "./LibraryView";

type SidebarProps = {
  onOpenLibrary: () => void;
  activeLibrarySection: LibrarySection | null;
  activePlaylistId: string | null;
  onOpenLibrarySection: (section: LibrarySection) => void;
  onCreatePlaylist: () => void;
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
  return (
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
        <button type="button" onClick={onCreatePlaylist} id="createPlaylistBtn">
          Create Playlist
        </button>
      </div>
    </div>
  );
}
