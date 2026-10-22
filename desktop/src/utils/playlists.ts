import type { GlobalTrackId, Playlist, Track } from "../types/music";
import { mergeVisibleTrackOrder } from "./trackCollectionOrder";
import { bindPackage, unbindPackages } from "./playlistPackages";
import { withPackages } from "./playlistStorage";

export function playlistTracks(playlist: Playlist, availableTracks: Track[]): Track[] {
  const byId = new Map(availableTracks.map(track => [track.globalId, track]));
  return playlist.trackIds.flatMap(id => {
    const track = byId.get(id);
    return track ? [track] : [];
  });
}

export function removePlaylistTracks(playlists: Playlist[], playlistId: string, trackIds: GlobalTrackId[]): Playlist[] {
  const removed = new Set(trackIds);
  return playlists.map(playlist => playlist.id === playlistId
    ? withPackages({ ...playlist, trackIds: playlist.trackIds.filter(id => !removed.has(id)) })
    : playlist);
}

export function bindPlaylistTracks(playlists: Playlist[], playlistId: string, trackIds: GlobalTrackId[]): Playlist[] {
  return playlists.map(playlist => playlist.id === playlistId
    ? withPackages(playlist, bindPackage(playlist.trackIds, playlist.packages ?? [], trackIds).packages)
    : playlist);
}

export function unbindPlaylistTracks(playlists: Playlist[], playlistId: string, trackIds: GlobalTrackId[]): Playlist[] {
  return playlists.map(playlist => playlist.id === playlistId
    ? withPackages(playlist, unbindPackages(playlist.trackIds, playlist.packages ?? [], trackIds).packages)
    : playlist);
}

export function reorderPlaylistTracks(
  playlists: Playlist[],
  playlistId: string,
  orderedVisibleIds: GlobalTrackId[],
): Playlist[] {
  return playlists.map((playlist) =>
    playlist.id === playlistId
      ? withPackages({
          ...playlist,
          trackIds: mergeVisibleTrackOrder(
            playlist.trackIds,
            orderedVisibleIds.filter((id) => playlist.trackIds.includes(id)),
          ),
        })
      : playlist,
  );
}
