import { useEffect, useState } from "react";
import { highestQualityArtwork } from "../api/server";
import type { Track } from "../types/music";
import { FluidGradientBackground } from "./FluidGradientBackground";
import "./BigscreenArtwork.css";

type ArtworkProps = {
  track: Track;
};

export function AlbumArtwork({ track }: ArtworkProps) {
  const [cover, setCover] = useState(track.cover);

  useEffect(() => {
    let cancelled = false;
    setCover(track.cover);

    void highestQualityArtwork(track).then((artwork) => {
      if (!cancelled && artwork !== null) setCover(artwork.url);
    });

    return () => {
      cancelled = true;
    };
  }, [
    track.albumId,
    track.cover,
    track.globalId,
    track.nativeCover,
    track.provider,
    track.upc,
  ]);

  return (
    <div id="albumCover">
      <img
        key={track.audio}
        src={cover}
        alt={`${track.album} album cover`}
        id="albumCoverImg"
        onError={() => setCover(track.cover)}
      />
    </div>
  );
}

export function BackgroundArtwork({ track }: ArtworkProps) {
  const [colors, setColors] = useState(["#000000", "#000000", "#000000"]);

  useEffect(() => {
    let cancelled = false;

    void highestQualityArtwork(track).then((artwork) => {
      if (!cancelled && artwork?.colors?.length === 3) {
        setColors(artwork.colors);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    track.albumId,
    track.cover,
    track.globalId,
    track.nativeCover,
    track.provider,
    track.upc,
  ]);

  return (
    <div id="backgroundFX" aria-hidden="true">
      <FluidGradientBackground colors={colors} seed={track.globalId} />
    </div>
  );
}
