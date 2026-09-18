import { useEffect, useState } from "react";
import { artworkPalette, thumbnailArtwork } from "../api/server";
import {
  cachedBigscreenArtwork,
  preloadBigscreenArtwork,
} from "../utils/artworkImages";
import type { Track } from "../types/music";
import { separateCollapsedPalette } from "../utils/backgroundPalette";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { cachedPlaylistArtwork } from "../utils/playlistArtworkCache";
import { FluidGradientBackground } from "./FluidGradientBackground";
import "./BigscreenArtwork.css";

type ArtworkProps = {
  track: Track;
};

type BackgroundArtworkProps = ArtworkProps & {
  active: boolean;
};

export function AlbumArtwork({ track, active }: BackgroundArtworkProps) {
  const [cover, setCover] = useState<string>(() =>
    cachedBigscreenArtwork(track) ?? whiteArtwork,
  );

  useEffect(() => {
    let cancelled = false;
    setCover(cachedBigscreenArtwork(track) ?? whiteArtwork);

    void cachedPlaylistArtwork(thumbnailArtwork(track)).then((source) => {
      if (!cancelled && source) setCover(source);
    });

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
      <>
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
          onError={() => setCover(whiteArtwork)}
        />
      </>
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

    void artworkPalette(track).then((palette) => {
      if (!cancelled && palette.length === 4) {
        setColors(separateCollapsedPalette(palette));
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
        colors={colors}
        seed={track.globalId}
        active={active}
      />
    </div>
  );
}
