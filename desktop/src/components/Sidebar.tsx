import "./Sidebar.css";
import type { Playlist } from "../types/music.ts";

type SidebarProps = {
  onOpenLibrary: () => void;
  onCreatePlaylist: () => void;
  playlists: Playlist[];
  onSelectPlaylist: (playlistId: string) => void;
};

export function Sidebar({
  onOpenLibrary,
  onCreatePlaylist,
  playlists,
  onSelectPlaylist,
}: SidebarProps) {
  return (
    <div id="sidebarMain">
      <div className="mainLogo">
        <img src="/ambra.svg" id="logoImg" />
      </div>
      <div id="libraryContainer">
        <text onClick={onOpenLibrary}>My Library</text>
        <div id="playlistContainer">
          {playlists.map((playlist) => (
            <div
              key={playlist.id}
              onClick={() => onSelectPlaylist(playlist.id)}
            >
              {playlist.name}
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
