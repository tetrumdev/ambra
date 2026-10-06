import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { cachedArtwork, preloadArtwork } from "../utils/artworkImages";
import { thumbnailSource } from "../api/server";
import { observeNearbyArtwork } from "../utils/nearbyArtwork";
import { whiteArtwork } from "../utils/artworkPlaceholder";

type ArtworkImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string | null | undefined;
};

export function ArtworkImage({ src: requestedSource, onError, ...imageProps }: ArtworkImageProps) {
  const source = requestedSource ? thumbnailSource(requestedSource) : whiteArtwork;
  const [resolved, setResolved] = useState<{ source: string; display: string } | null>(null);
  const display = resolved?.source === source ? resolved.display : cachedArtwork(source) ? source : whiteArtwork;
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
    void preloadArtwork(source).then(() => source).catch(async () => {
      if (!requestedSource || requestedSource === source) throw new Error("Artwork unavailable");
      await preloadArtwork(requestedSource);
      return requestedSource;
    })
      .then(display => {
        if (!cancelled) setResolved({ source, display });
      })
      .catch(() => {
        if (!cancelled) setResolved({ source, display: whiteArtwork });
      });
    return () => { cancelled = true; };
  }, [nearby, source, requestedSource]);

  return (
    <img
      ref={imageRef}
      decoding="async"
      {...imageProps}
      loading={nearby ? "eager" : "lazy"}
      src={display}
      data-placeholder={display === whiteArtwork || undefined}
      onError={(event) => {
        onError?.(event);
        setResolved({ source, display: whiteArtwork });
      }}
    />
  );
}
