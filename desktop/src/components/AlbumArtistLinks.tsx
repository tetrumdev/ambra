import { Fragment } from "react";
import type { CatalogAlbum } from "../api/server";
import type { Track } from "../types/music";
import type { BrowseEntity } from "../utils/browse";

/** Album credits link to the artist's provider identity, including collaborative releases. */
export function AlbumArtistLinks({ album, tracks = [], onOpenEntity }: {
  album: CatalogAlbum;
  tracks?: Track[];
  onOpenEntity: (entity: BrowseEntity) => void;
}) {
  const credited = album.artists?.length ? album.artists : tracks.find(track => track.albumArtists.length)?.albumArtists;
  const artists = credited?.filter(artist => artist.providerId || album.provider === "local") ?? [];
  if (!artists.length && album.provider === "local") artists.push({ providerId: "", name: album.artist, imageUrl: null });
  if (!artists.length) return <>{album.artist}</>;
  return <>{artists.map((artist, index) => <Fragment key={`${artist.providerId}:${artist.name}`}>
    {index > 0 && ", "}
    <button type="button" className="entityLink" onClick={event => {
      event.stopPropagation();
      const id = artist.providerId || artist.name;
      onOpenEntity({ kind: "artist", artist: {
        id: id.startsWith(`${album.provider}:`) ? id : `${album.provider}:${id}`,
        provider: album.provider, name: artist.name, imageUrl: artist.imageUrl,
      } });
    }}>{artist.name}</button>
  </Fragment>)}</>;
}
