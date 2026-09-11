import { useRef, useState } from "react";
import type { Track } from "../types/music";
import { removePlaylistTracks } from "../utils/playlists";
import { addPlaylistTrack, emptyPlaylists, parsePlaylistSnapshot, PLAYLIST_STORAGE_KEY, savePlaylistSnapshot, type PlaylistSnapshot } from "../utils/playlistStorage";

export function usePlaylists() {
  const [initial] = useState(() => {
    try {
      return { snapshot: parsePlaylistSnapshot(localStorage.getItem(PLAYLIST_STORAGE_KEY)), error: null };
    } catch {
      return { snapshot: emptyPlaylists(), error: "Saved playlists could not be loaded. The stored data has been left untouched." };
    }
  });
  const [snapshot, setSnapshot] = useState(initial.snapshot);
  const current = useRef(snapshot);
  const [error, setError] = useState<string | null>(initial.error);

  function commit(next: PlaylistSnapshot): boolean {
    if (initial.error) return false;
    try {
      // Save the complete membership + metadata change before confirming it in the UI.
      savePlaylistSnapshot(next);
      current.current = next;
      setSnapshot(next);
      setError(null);
      return true;
    } catch {
      setError("Could not save playlists. Your previous playlists are unchanged; free some storage and try again.");
      return false;
    }
  }

  function create(name = "New Playlist", track?: Track) {
    if (!name.trim()) return false;
    const playlist = { id: crypto.randomUUID(), name: name.trim(), trackIds: [] as string[] };
    let next = { ...current.current, playlists: [...current.current.playlists, playlist] };
    if (track) next = addPlaylistTrack(next, playlist.id, track);
    return commit(next);
  }

  return {
    playlists: snapshot.playlists,
    tracks: snapshot.tracks,
    error,
    create,
    rename: (id: string, name: string) => Boolean(name.trim()) && current.current.playlists.some(playlist => playlist.id === id) && commit({
      ...current.current,
      playlists: current.current.playlists.map(playlist => playlist.id === id ? { ...playlist, name: name.trim() } : playlist),
    }),
    deletePlaylist: (id: string) => current.current.playlists.some(playlist => playlist.id === id) && commit({
      ...current.current,
      playlists: current.current.playlists.filter(playlist => playlist.id !== id),
    }),
    addTrack: (id: string, track: Track) => current.current.playlists.some(playlist => playlist.id === id) && commit(addPlaylistTrack(current.current, id, track)),
    removeTracks: (id: string, ids: string[]) => commit({ ...current.current, playlists: removePlaylistTracks(current.current.playlists, id, ids) }),
  };
}
