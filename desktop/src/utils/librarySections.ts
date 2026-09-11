import type { Track } from "../types/music";

export type LibraryArtist = {
  id: string;
  name: string;
  imageUrl: string | null;
  albumCount: number;
  trackCount: number;
};

export type LibraryAlbum = {
  id: string;
  name: string;
  artist: string;
  cover: string;
  releaseYear: string | null;
  trackCount: number;
};

function albumKey(track: Track) {
  const fallbackIdentity = `${track.artist}:${track.album}:${track.albumVersion ?? ""}`;
  return `${track.provider}:${track.albumId ?? fallbackIdentity}`;
}

export function libraryArtists(tracks: Track[]): LibraryArtist[] {
  const artists = new Map<
    string,
    Omit<LibraryArtist, "albumCount" | "trackCount"> & {
      albumIds: Set<string>;
      trackIds: Set<string>;
    }
  >();

  for (const track of tracks) {
    const trackArtists = track.artists.length > 0
      ? track.artists
      : [{ providerId: track.artist, name: track.artist, imageUrl: null }];

    for (const artist of trackArtists) {
      const id = `${track.provider}:${artist.providerId || artist.name}`;
      const current = artists.get(id) ?? {
        id,
        name: artist.name,
        imageUrl: artist.imageUrl,
        albumIds: new Set<string>(),
        trackIds: new Set<string>(),
      };
      current.imageUrl ??= artist.imageUrl;
      current.albumIds.add(albumKey(track));
      current.trackIds.add(track.globalId);
      artists.set(id, current);
    }
  }

  return [...artists.values()]
    .map(({ albumIds, trackIds, ...artist }) => ({
      ...artist,
      albumCount: albumIds.size,
      trackCount: trackIds.size,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function libraryAlbums(tracks: Track[]): LibraryAlbum[] {
  const albums = new Map<string, LibraryAlbum>();

  for (const track of tracks) {
    const id = albumKey(track);
    const current = albums.get(id);
    if (current) {
      current.trackCount += 1;
      continue;
    }

    albums.set(id, {
      id,
      name: track.album,
      artist:
        track.albumArtists.map((artist) => artist.name).join(", ") ||
        track.artist,
      cover: track.cover,
      releaseYear: track.releaseDate?.slice(0, 4) ?? null,
      trackCount: 1,
    });
  }

  return [...albums.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}
