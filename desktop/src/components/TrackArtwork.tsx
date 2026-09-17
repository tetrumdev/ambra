import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { highestQualityArtwork, thumbnailArtwork } from "../api/server";
import { preloadArtwork } from "../utils/artworkImages";
import fallbackCover from "../assets/images/fallbackCover.png";
import type { Track } from "../types/music";

type TrackArtworkProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  track: Track;
};

export function TrackArtwork({ track, onError, onLoad, ...imageProps }: TrackArtworkProps) {
  const thumbnail = thumbnailArtwork(track);
  const [replacement, setReplacement] = useState<{ key: string; src: string } | null>(null);
  const src = replacement?.key === thumbnail ? replacement.src : thumbnail;
  const setSrc = (src: string) => setReplacement({ key: thumbnail, src });
  const trackRef = useRef(track);

  useEffect(() => {
    trackRef.current = track;
  }, [track]);

  const resolveBrokenArtwork: ImgHTMLAttributes<HTMLImageElement>["onError"] = (
    event,
  ) => {
    onError?.(event);
    const failedTrack = trackRef.current;

    if (src === thumbnail && thumbnail !== failedTrack.cover) {
      setSrc(failedTrack.cover);
      return;
    }
    if (src !== failedTrack.cover) {
      setSrc(fallbackCover);
      return;
    }

    void highestQualityArtwork(failedTrack).then((artwork) => {
      if (trackRef.current !== failedTrack) return;
      setSrc(artwork?.url && artwork.url !== failedTrack.cover ? artwork.url : fallbackCover);
    });
  };

  return <img loading="lazy" decoding="async" {...imageProps} src={src}
    onLoad={(event) => {
      onLoad?.(event);
      if (src === thumbnail && thumbnail !== track.cover) void preloadArtwork(src).catch(() => {});
    }}
    onError={resolveBrokenArtwork} />;
}
