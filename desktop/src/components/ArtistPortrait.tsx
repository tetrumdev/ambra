import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CatalogArtist } from "../api/server";
import { observeNearbyArtwork } from "../utils/nearbyArtwork";
import { cachedArtistImage, resolveArtistImage, subscribeArtistImages } from "../utils/artistImages";
import { ArtworkImage } from "./ArtworkImage";
import { AlbumArtwork } from "./AlbumArtwork";

export function ArtistPortrait({ artist, eager = false, expandable = false }: { artist: CatalogArtist; eager?: boolean; expandable?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(eager);
  const image = useSyncExternalStore(subscribeArtistImages, () => cachedArtistImage(artist), () => cachedArtistImage(artist));
  useEffect(() => {
    if (container.current && !nearby) return observeNearbyArtwork(container.current, () => setNearby(true));
  }, [nearby]);
  useEffect(() => {
    if (nearby) void resolveArtistImage(artist, eager);
  }, [artist.id, artist.provider, artist.name, nearby, eager]);
  const source = image ?? artist.imageUrl;
  return <div className="artistPortrait" ref={container}>
    <div className="searchEntityImage">
      {/* The initial sits under the photo, so a slow or missing portrait never leaves a blank circle. */}
      <span aria-hidden={source ? true : undefined}>{artist.name.slice(0, 1).toLocaleUpperCase()}</span>
      {source && (expandable
        ? <AlbumArtwork src={source} title={artist.name} noun="portrait" />
        : <ArtworkImage src={source} alt={`${artist.name} portrait`} loading={nearby ? "eager" : "lazy"} />)}
    </div>
  </div>;
}
