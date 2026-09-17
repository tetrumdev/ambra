import { useEffect, useRef, useState } from "react";
import { observeNearbyArtwork } from "../utils/nearbyArtwork";
import { artistImage } from "../utils/artistImages";

export function ArtistPortrait({ name, fallback }: { name: string; fallback: string | null }) {
  const container = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(false);
  useEffect(() => {
    if (container.current) return observeNearbyArtwork(container.current, () => setNearby(true));
  }, []);
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    setImage(null);
    if (nearby && (!fallback || failed.includes(fallback))) {
      void artistImage(name).then(value => { if (!cancelled) setImage(value); });
    }
    return () => { cancelled = true; };
  }, [name, fallback, failed, nearby]);
  const source = [fallback, image].find(url => url && !failed.includes(url));
  return <div className="artistPortrait" ref={container}>
    <div className="searchEntityImage">
      {source ? <img src={source} alt={`${name} portrait`} loading="lazy" onError={() => setFailed(current => [...current, source])} /> : <span>{name.slice(0, 1)}</span>}
    </div>
  </div>;
}
