import type { GlobalTrackId, Playlist, Track } from "../types/music";

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
    ? { ...playlist, trackIds: playlist.trackIds.filter(id => !removed.has(id)) }
    : playlist);
}
