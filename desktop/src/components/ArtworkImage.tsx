import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { preloadArtwork } from "../utils/artworkImages";
import { observeNearbyArtwork } from "../utils/nearbyArtwork";
import { whiteArtwork } from "../utils/artworkPlaceholder";

type ArtworkImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string | null | undefined;
};

export function ArtworkImage({ src: requestedSource, onError, ...imageProps }: ArtworkImageProps) {
  const source = requestedSource || whiteArtwork;
  const [resolved, setResolved] = useState<{ source: string; display: string } | null>(null);
  const display = resolved?.source === source ? resolved.display : whiteArtwork;
  const imageRef = useRef<HTMLImageElement>(null);
  const [nearby, setNearby] = useState(imageProps.loading === "eager");

  useEffect(() => {
    const element = imageRef.current;
    if (!element || nearby) return;
    return observeNearbyArtwork(element, () => setNearby(true));
  }, [nearby]);

  useEffect(() => {
    if (!nearby || source === whiteArtwork) return;
    let cancelled = false;
    void preloadArtwork(source)
      .then(() => {
        if (!cancelled) setResolved({ source, display: source });
      })
      .catch(() => {
        if (!cancelled) setResolved({ source, display: whiteArtwork });
      });
    return () => { cancelled = true; };
  }, [nearby, source]);

  return (
    <img
      ref={imageRef}
      loading="lazy"
      decoding="async"
      {...imageProps}
      src={display}
      onError={(event) => {
        onError?.(event);
        setResolved({ source, display: whiteArtwork });
      }}
    />
  );
}
