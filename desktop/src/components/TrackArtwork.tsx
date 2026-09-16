import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { highestQualityArtwork } from "../api/server";
import fallbackCover from "../assets/images/fallbackCover.png";
import type { Track } from "../types/music";

type TrackArtworkProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  track: Track;
};

export function TrackArtwork({ track, onError, ...imageProps }: TrackArtworkProps) {
  const [src, setSrc] = useState(track.cover);
  const trackRef = useRef(track);

  useEffect(() => {
    trackRef.current = track;
    setSrc(track.cover);
  }, [track]);

  const resolveBrokenArtwork: ImgHTMLAttributes<HTMLImageElement>["onError"] = (
    event,
  ) => {
    onError?.(event);
    const failedTrack = trackRef.current;

    if (src !== failedTrack.cover) {
      setSrc(fallbackCover);
      return;
    }

    void highestQualityArtwork(failedTrack).then((artwork) => {
      if (trackRef.current !== failedTrack) return;
      setSrc(artwork?.url ?? fallbackCover);
    });
  };

  return <img {...imageProps} src={src} onError={resolveBrokenArtwork} />;
}
