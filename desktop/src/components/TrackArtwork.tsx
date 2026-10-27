import { useEffect, useMemo, useRef, useState, type ImgHTMLAttributes } from "react";
import { highestQualityArtwork, thumbnailArtwork } from "../api/server";
import { cachedArtwork, preloadArtwork } from "../utils/artworkImages";
import type { Track } from "../types/music";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { cachedPlaylistArtwork } from "../utils/playlistArtworkCache";
import { observeNearbyArtwork } from "../utils/nearbyArtwork";
import { providerThumbnail } from "../utils/providerThumbnail";

type TrackArtworkProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  track: Track;
  preferProviderThumbnail?: boolean;
};

export function TrackArtwork({ track, preferProviderThumbnail = false, onError, onLoad, ...imageProps }: TrackArtworkProps) {
  const thumbnail = thumbnailArtwork(track);
  const primary = preferProviderThumbnail ? providerThumbnail(track.nativeCover ?? track.cover) : thumbnail;
  const key = `${track.globalId}:${primary}`;
  const [resolved, setResolved] = useState<{ key: string; src: string } | null>(null);
  const src = resolved?.key === key ? resolved.src : cachedArtwork(primary) ? primary : whiteArtwork;
  const imageRef = useRef<HTMLImageElement>(null);
  const [nearby, setNearby] = useState(imageProps.loading === "eager");
  const candidates = useMemo(
    () => [...new Set([primary, thumbnail, track.cover].filter(source => source && source !== whiteArtwork))],
    [primary, thumbnail, track.cover],
  );

  useEffect(() => {
    const element = imageRef.current;
    if (!element || nearby) return;
    return observeNearbyArtwork(element, () => setNearby(true));
  }, [nearby]);

  useEffect(() => {
    if (!nearby) return;
    let cancelled = false;

    void (async () => {
      // Search starts public CDN requests immediately; a pending offline-cache write must not delay them.
      const cached = preferProviderThumbnail ? null : await cachedPlaylistArtwork(thumbnail);
      const sources = cached ? [cached, ...candidates] : candidates;
      for (const candidate of sources) {
        try {
          await preloadArtwork(candidate, false, {
            fetchPriority: imageProps.fetchPriority,
            timeoutMs: preferProviderThumbnail ? 3000 : undefined,
          });
          if (!cancelled) setResolved({ key, src: candidate });
          return;
        } catch {
          // Try the provider's original artwork before resolving a larger copy.
        }
      }

      const artwork = await highestQualityArtwork(track);
      if (!artwork?.url || cancelled) return;
      try {
        await preloadArtwork(artwork.url);
        if (!cancelled) setResolved({ key, src: artwork.url });
      } catch {
        // The white placeholder remains visible.
      }
    })();

    return () => { cancelled = true; };
  }, [candidates, key, nearby, thumbnail, track, preferProviderThumbnail, imageProps.fetchPriority]);

  return <img ref={imageRef} loading="lazy" decoding="async" {...imageProps} src={src}
    onLoad={onLoad}
    onError={(event) => {
      onError?.(event);
      setResolved({ key, src: whiteArtwork });
    }} />;
}
