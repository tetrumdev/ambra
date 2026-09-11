import { useEffect, useState } from "react";
import { artistImage } from "../utils/artistImages";

export function ArtistPortrait({ name, fallback }: { name: string; fallback: string | null }) {
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    setImage(null);
    if (!fallback || failed.includes(fallback)) {
      void artistImage(name).then(value => { if (!cancelled) setImage(value); });
    }
    return () => { cancelled = true; };
  }, [name, fallback, failed]);
  const source = [fallback, image].find(url => url && !failed.includes(url));
  return <div className="artistPortrait">
    <div className="searchEntityImage">
      {source ? <img src={source} alt={`${name} portrait`} loading="lazy" onError={() => setFailed(current => [...current, source])} /> : <span>{name.slice(0, 1)}</span>}
    </div>
  </div>;
}
