import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Track } from "../types/music";
import { bindPlaylistTracks, removePlaylistTracks, reorderPlaylistTracks, unbindPlaylistTracks } from "../utils/playlists";
import { addPlaylistTrack, emptyPlaylists, parsePlaylistSnapshot, PLAYLIST_STORAGE_KEY, savePlaylistSnapshot, withPackages, type PlaylistSnapshot } from "../utils/playlistStorage";
import { getPersistentItem } from "../utils/persistentStorage";
import { getServerItem, setServerItem, subscribeServerState } from "../utils/serverState";

import { subscribeLocalStorage } from "../utils/storageEvents";
import { forStorage, fromStorage, serverConnection } from "../api/serverConnection";
import { isDeviceTrack } from "../utils/nativeAudioSource";
import { useClientConnection } from "./ClientConnectionContext";

const storedPlaylists = () => getPersistentItem(PLAYLIST_STORAGE_KEY);
const serverPlaylists = () => fromStorage(getServerItem(PLAYLIST_STORAGE_KEY));
const writeSharedPlaylist = (key: string, value: string) => {
  const snapshot = parsePlaylistSnapshot(value);
  if (snapshot.tracks.some(isDeviceTrack)) {
    throw new Error("Private local music must be explicitly imported before adding it to a server playlist.");
  }
  setServerItem(key, forStorage(value));
};

function usePlaylistStore(remote: boolean) {
  const raw = useSyncExternalStore(remote ? subscribeServerState : subscribeLocalStorage, remote ? serverPlaylists : storedPlaylists);
  const loaded = useMemo(() => {
    try {
      return { snapshot: parsePlaylistSnapshot(raw), error: null };
    } catch {
      return { snapshot: emptyPlaylists(), error: "Saved playlists could not be loaded. The stored data has been left untouched." };
    }
  }, [raw]);
  const snapshot = loaded.snapshot;
  const current = useRef(snapshot);
  current.current = snapshot;
  const [error, setError] = useState<string | null>(null);

  function commit(next: PlaylistSnapshot): boolean {
    if (loaded.error) return false;
    try {
      // Save the complete membership + metadata change before confirming it in the UI.
      const saved = savePlaylistSnapshot(next, remote ? writeSharedPlaylist : undefined);
      current.current = saved;
      setError(null);
      return true;
    } catch {
      setError("Could not save playlists. Your previous playlists are unchanged; free some storage and try again.");
      return false;
    }
  }

  function create(name = "New Playlist", track?: Track) {
    if (!name.trim()) return null;
    const playlist = { id: crypto.randomUUID(), name: name.trim(), trackIds: [] as string[] };
    let next = { ...current.current, playlists: [...current.current.playlists, playlist] };
    if (track) next = addPlaylistTrack(next, playlist.id, track);
    return commit(next) ? playlist.id : null;
  }

  /** A new AMBRA playlist with the same name and songs, from any playlist including a service's. */
  function duplicate(name: string, tracks: Track[]) {
    if (!name.trim()) return null;
    const playlist = { id: crypto.randomUUID(), name: name.trim(), trackIds: [...new Set(tracks.map(track => track.globalId))] };
    const saved = new Map(current.current.tracks.map(track => [track.globalId, track]));
    for (const track of tracks) saved.set(track.globalId, track);
    return commit({ ...current.current, playlists: [...current.current.playlists, playlist], tracks: [...saved.values()] }) ? playlist.id : null;
  }

  /** Swaps songs for other copies in place, keeping their order; a copy already present is not repeated. */
  function replaceTracks(id: string, replacements: Map<string, Track>) {
    if (!current.current.playlists.some(playlist => playlist.id === id)) return false;
    const saved = new Map(current.current.tracks.map(track => [track.globalId, track]));
    for (const track of replacements.values()) saved.set(track.globalId, track);
    return commit({
      ...current.current,
      tracks: [...saved.values()],
      playlists: current.current.playlists.map(playlist => playlist.id === id
        ? withPackages(
          { ...playlist, trackIds: [...new Set(playlist.trackIds.map(trackId => replacements.get(trackId)?.globalId ?? trackId))] },
          playlist.packages?.map(pack => pack.map(trackId => replacements.get(trackId)?.globalId ?? trackId)),
        )
        : playlist),
    });
  }

  return {
    playlists: snapshot.playlists,
    tracks: snapshot.tracks,
    error: loaded.error ?? error,
    create,
    duplicate,
    replaceTracks,
    rename: (id: string, name: string) => Boolean(name.trim()) && current.current.playlists.some(playlist => playlist.id === id) && commit({
      ...current.current,
      playlists: current.current.playlists.map(playlist => playlist.id === id ? { ...playlist, name: name.trim() } : playlist),
    }),
    deletePlaylist: (id: string) => current.current.playlists.some(playlist => playlist.id === id) && commit({
      ...current.current,
      playlists: current.current.playlists.filter(playlist => playlist.id !== id),
    }),
    addTrack: (id: string, track: Track) => current.current.playlists.some(playlist => playlist.id === id) && commit(addPlaylistTrack(current.current, id, track)),
    updateTrack: (track: Track) => {
      if (!current.current.tracks.some(item => item.globalId === track.globalId)) return false;
      return commit({
        ...current.current,
        tracks: current.current.tracks.map(item => item.globalId === track.globalId ? track : item),
      });
    },
    removeTracks: (id: string, ids: string[]) => commit({ ...current.current, playlists: removePlaylistTracks(current.current.playlists, id, ids) }),
    bindTracks: (id: string, ids: string[]) => ids.length >= 2 && commit({ ...current.current, playlists: bindPlaylistTracks(current.current.playlists, id, ids) }),
    unbindTracks: (id: string, ids: string[]) => commit({ ...current.current, playlists: unbindPlaylistTracks(current.current.playlists, id, ids) }),
    reorderTracks: (id: string, orderedTrackIds: string[]) => commit({
      ...current.current,
      playlists: reorderPlaylistTracks(
        current.current.playlists,
        id,
        orderedTrackIds,
      ),
    }),
  };
}

/** Local playlists keep their IDs and storage. Shared playlists always write back to their server. */
export function usePlaylists() {
  const local = usePlaylistStore(false);
  const remote = usePlaylistStore(true);
  const { connected, sharedPlayback } = useClientConnection();
  const prefix = `ambra-server-playlist:${serverConnection?.server?.publicKey ?? "unpaired"}:`;
  const owner = (id: string) => id.startsWith(prefix) ? remote : local;
  const original = (id: string) => id.startsWith(prefix) ? id.slice(prefix.length) : id;
  const playlists = useMemo(() => [
    ...(sharedPlayback ? [] : local.playlists),
    ...(connected ? remote.playlists.map(playlist => ({ ...playlist, id: prefix + playlist.id, name: `${playlist.name} (Server)` })) : []),
  ], [local.playlists, remote.playlists, connected, sharedPlayback, prefix]);
  const tracks = useMemo(() => [...local.tracks, ...(connected ? remote.tracks : [])], [local.tracks, remote.tracks, connected]);
  return {
    playlists, tracks, error: local.error ?? (connected ? remote.error : null),
    create: local.create, duplicate: local.duplicate,
    replaceTracks: (id: string, replacements: Map<string, Track>) => owner(id).replaceTracks(original(id), replacements),
    rename: (id: string, name: string) => owner(id).rename(original(id), name),
    deletePlaylist: (id: string) => owner(id).deletePlaylist(original(id)),
    addTrack: (id: string, track: Track) => owner(id).addTrack(original(id), track),
    updateTrack: (track: Track) => local.updateTrack(track),
    removeTracks: (id: string, ids: string[]) => owner(id).removeTracks(original(id), ids),
    bindTracks: (id: string, ids: string[]) => owner(id).bindTracks(original(id), ids),
    unbindTracks: (id: string, ids: string[]) => owner(id).unbindTracks(original(id), ids),
    reorderTracks: (id: string, ids: string[]) => owner(id).reorderTracks(original(id), ids),
  };
}
