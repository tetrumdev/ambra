import { useEffect, useState } from "react";
import { highestQualityArtwork } from "../api/server";
import type { Track } from "../types/music";
import { separateCollapsedPalette } from "../utils/backgroundPalette";
import { FluidGradientBackground } from "./FluidGradientBackground";
import "./BigscreenArtwork.css";

type ArtworkProps = {
  track: Track;
};

type BackgroundArtworkProps = ArtworkProps & {
  active: boolean;
};

export function AlbumArtwork({ track, active }: BackgroundArtworkProps) {
  const [cover, setCover] = useState(track.cover);

  useEffect(() => {
    let cancelled = false;
    setCover(track.cover);

    void highestQualityArtwork(track).then(async (artwork) => {
      if (!cancelled && artwork !== null) {
        const image = new Image();
        image.src = artwork.url;
        try {
          await image.decode();
          if (!cancelled) setCover(artwork.url);
        } catch {
          // Keep the already displayed cover if the larger image fails.
        }
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
    <div id="albumCover" data-active={active} aria-hidden={!active}>
      <img
        src={cover}
        alt=""
        aria-hidden="true"
        className="albumCoverContrast"
      />
      <img
        src={cover}
        alt={`${track.album} album cover`}
        id="albumCoverImg"
        onError={() => setCover(track.cover)}
      />
    </div>
  );
}

export function BackgroundArtwork({ track, active }: BackgroundArtworkProps) {
  const [colors, setColors] = useState([
    "#000000",
    "#000000",
    "#000000",
    "#000000",
  ]);

  useEffect(() => {
    let cancelled = false;

    void highestQualityArtwork(track).then((artwork) => {
      if (!cancelled && artwork?.colors?.length === 4) {
        setColors(separateCollapsedPalette(artwork.colors));
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
    <div id="backgroundFX" aria-hidden="true" data-active={active}>
      <FluidGradientBackground
        colors={colors}
        seed={track.globalId}
        active={active}
      />
    </div>
  );
}
