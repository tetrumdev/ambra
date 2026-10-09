import { useEffect, useState } from "react";
import {
  artworkPalette,
  thumbnailArtwork,
  type ArtworkPalette,
} from "../api/server";
import {
  cachedBigscreenArtwork,
  preloadBigscreenArtwork,
} from "../utils/artworkImages";
import type { Track } from "../types/music";
import {
  coverEdgeLuminances,
  coverSeparation,
  neutralCoverSeparation,
  separateCollapsedPalette,
  type CoverSeparation,
} from "../utils/backgroundPalette";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { FluidGradientBackground } from "./FluidGradientBackground";
import "./BigscreenArtwork.css";

type ArtworkProps = {
  track: Track;
};

type BackgroundArtworkProps = ArtworkProps & {
  active: boolean;
};

const EDGE_SAMPLE_SIZE = 16;

// Reads how bright each side of the cover is. Covers the webview may not read
// back (no CORS) resolve to null and fall back to the palette.
function sampleCoverEdges(source: string): Promise<number[] | null> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.src = source;
  return image.decode().then(() => {
    const canvas = document.createElement("canvas");
    canvas.width = EDGE_SAMPLE_SIZE;
    canvas.height = EDGE_SAMPLE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, EDGE_SAMPLE_SIZE, EDGE_SAMPLE_SIZE);
    const { data } = context.getImageData(0, 0, EDGE_SAMPLE_SIZE, EDGE_SAMPLE_SIZE);
    return coverEdgeLuminances(data, EDGE_SAMPLE_SIZE);
  }).catch(() => null);
}

export function AlbumArtwork({ track, active }: BackgroundArtworkProps) {
  const [cover, setCover] = useState<string>(() =>
    cachedBigscreenArtwork(track) ?? whiteArtwork,
  );

  useEffect(() => {
    let cancelled = false;
    setCover(cachedBigscreenArtwork(track) ?? whiteArtwork);

    void preloadBigscreenArtwork(track).then((source) => {
      if (!cancelled && source) setCover(source);
    });

    return () => {
      cancelled = true;
    };
  }, [
    track.albumId,
    track.cover,
    track.nativeCover,
    track.provider,
    track.upc,
  ]);

  return (
    <div id="albumCover" data-active={active} aria-hidden={!active}>
      <img
        src={cover}
        alt={`${track.album} album cover`}
        id="albumCoverImg"
        onError={() => setCover(whiteArtwork)}
      />
    </div>
  );
}

export function BackgroundArtwork({ track, active }: BackgroundArtworkProps) {
  const [palette, setPalette] = useState<ArtworkPalette>({
    colors: ["#000000", "#000000", "#000000", "#000000"],
    weights: [1, 0, 0, 0],
  });
  const [separation, setSeparation] = useState<CoverSeparation>(neutralCoverSeparation);

  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      artworkPalette(track),
      sampleCoverEdges(thumbnailArtwork(track)),
    ]).then(([palette, edges]) => {
      if (!cancelled && palette.colors.length === 4) {
        const colors = separateCollapsedPalette(palette.colors);
        setPalette({ ...palette, colors });
        setSeparation(coverSeparation(edges, colors, palette.weights));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    track.albumId,
    track.cover,
    track.nativeCover,
    track.provider,
    track.upc,
  ]);

  return (
    <div id="backgroundFX" aria-hidden="true" data-active={active}>
      <FluidGradientBackground
        colors={palette.colors}
        weights={palette.weights}
        separation={separation}
        coverId="albumCover"
        seed={track.globalId}
        active={active}
      />
    </div>
  );
}
