import type { CatalogAlbum, CatalogArtist } from "../api/server";
import type { MusicProvider, Track, TrackArtist } from "../types/music";

export type BrowseEntity = { kind: "album"; album: CatalogAlbum } | { kind: "artist"; artist: CatalogArtist };
export const entityKey = (entity: BrowseEntity) => `${entity.kind}:${entity.kind === "album" ? entity.album.id : entity.artist.id}`;

export function entityProvider(id: string): MusicProvider {
  const provider = id.split(":", 1)[0];
  if (provider === "local" || provider === "tidal" || provider === "qobuz" || provider === "spotify") return provider;
  throw new Error("Unknown catalog provider");
}
function albumKey(track: Track) {
  return `${track.provider}:${track.albumId ?? `${track.artist}:${track.album}:${track.albumVersion ?? ""}`}`;
}
export function albumForTrack(track: Track): CatalogAlbum {
  return { id: albumKey(track), provider: track.provider, title: track.album, artist: track.albumArtists.map(artist => artist.name).join(", ") || track.artist, imageUrl: track.fullCover ?? track.cover, releaseDate: track.releaseDate, version: track.albumVersion, upc: track.upc };
}
export function artistForTrack(track: Track, artist: TrackArtist = track.artists[0] ?? { providerId: track.artist, name: track.artist, imageUrl: null }): CatalogArtist {
  return { id: `${track.provider}:${artist.providerId || artist.name}`, provider: track.provider, name: artist.name, imageUrl: artist.imageUrl };
}
export function sortAlbumTracks(tracks: Track[]): Track[] {
  return [...tracks].sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? Number.MAX_SAFE_INTEGER) - (b.trackNumber ?? Number.MAX_SAFE_INTEGER));
}
export function tracksForEntity(entity: BrowseEntity, tracks: Track[]): Track[] {
  return tracks.filter(track => entity.kind === "album" ? albumKey(track) === entity.album.id : track.provider === entity.artist.provider && [...track.artists, ...track.albumArtists].some(artist => `${track.provider}:${artist.providerId || artist.name}` === entity.artist.id))
    .sort((a, b) => entity.kind === "album" ? (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? Number.MAX_SAFE_INTEGER) - (b.trackNumber ?? Number.MAX_SAFE_INTEGER) : a.album.localeCompare(b.album) || (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
}
