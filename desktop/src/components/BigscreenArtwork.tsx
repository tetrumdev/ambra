import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { motion } from "../utils/motion";
import {
  artworkPalette,
  thumbnailArtwork,
  type ArtworkPalette,
} from "../api/server";
import {
  cachedBigscreenArtwork,
  preloadBigscreenArtwork,
  settledBigscreenArtwork,
} from "../utils/artworkImages";
import type { Track } from "../types/music";
import {
  coverSeparation,
  neutralCoverSeparation,
  sampleCoverEdges,
  separateCollapsedPalette,
  type CoverSeparation,
} from "../utils/backgroundPalette";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { FluidGradientBackground } from "./FluidGradientBackground";
import "./BigscreenArtwork.css";
import { SURFACE_BLACK } from "../utils/surfaceBlack";
import { reducedMotion } from "../utils/reducedMotion";

type ArtworkProps = {
  track: Track | undefined;
};

type BackgroundArtworkProps = ArtworkProps & {
  active: boolean;
  animate?: boolean;
  playing?: boolean;
  coverId?: string;
  /** Visible share of the background beside the cover; see coverSeparation. */
  coverDim?: number;
  /** How long a change in coverDim eases, in step with the lyrics backdrop fading. */
  coverDimMs?: number;
};

type CoverLayer = {
  id: number;
  src: string;
  /** Which album the image belongs to; a different album slides, a sharper copy of the same one fades. */
  album: string;
  motion: "none" | "fade" | "slide";
  direction: number;
  leaving: boolean;
};


const albumKey = (track: Track) => JSON.stringify([track.provider, track.albumId, track.cover, track.nativeCover, track.upc]);
/** How long a song's cover may load before a smaller copy stands in for it. */
const COVER_WAIT_MS = 500;

export function AlbumArtwork({ track, active, layout = "center", resting = false, direction }: ArtworkProps & {
  active: boolean;
  layout?: "center" | "lyrics";
  /** The lyrics left on their own at the end of the vocals, or are returning on their own with the next song, so the cover drifts instead of gliding. */
  resting?: boolean;
  /** 1 when the player moved forward, -1 when it went back; the next cover slides in from that side. */
  direction?: () => number;
}) {
  const [layers, setLayers] = useState<CoverLayer[]>(() => {
    const src = track ? cachedBigscreenArtwork(track) ?? whiteArtwork : whiteArtwork;
    return [{ id: 0, src, album: track ? albumKey(track) : "", motion: "none", direction: 1, leaving: false }];
  });
  const nextId = useRef(1);
  const show = useCallback((src: string, album: string) => {
    setLayers((current) => {
      const top = current[current.length - 1];
      if (top && !top.leaving && top.src === src) return current;
      const motion: CoverLayer["motion"] = !top || top.src === whiteArtwork || top.album === album ? "fade" : "slide";
      const step = motion === "slide" ? direction?.() ?? 1 : 1;
      // Older layers leave the same way the new one arrives; at most one stays behind to cover the swap.
      const leaving = current.filter((layer) => !layer.leaving).map((layer) => ({ ...layer, leaving: true, motion, direction: step }));
      return [...leaving.slice(-1), { id: nextId.current++, src, album, motion, direction: step, leaving: false }];
    });
  }, [direction]);
  const key = track ? albumKey(track) : "";

  // The cover glides between layouts, but follows a window resize at once. Rather than a CSS
  // transition (which a resize would set off too), the switch itself animates from where the
  // cover was on screen, read while the old layout is still showing.
  const cover = useRef<HTMLDivElement>(null);
  const laidOutAs = useRef(layout);
  const before = useRef<DOMRect | null>(null);
  const glide = useRef<Animation | null>(null);
  if (laidOutAs.current !== layout) {
    laidOutAs.current = layout;
    // Mid-glide, this is wherever the cover is on screen, so turning back is seamless.
    before.current = cover.current?.getBoundingClientRect() ?? null;
  }
  useLayoutEffect(() => {
    const element = cover.current;
    const from = before.current;
    before.current = null;
    if (!element || !from) return;
    glide.current?.cancel();
    glide.current = null;
    if (reducedMotion()) return;
    const to = element.getBoundingClientRect();
    if (!to.width || !from.width) return;
    // Only the transform moves, so the glide runs on the compositor instead of laying the
    // cover out and resampling its image on every frame. Its resting transform centres it.
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    glide.current = element.animate([
      { transform: `translate(${dx}px, ${dy}px) translate(-50%, -50%) scale(${from.width / to.width})` },
      { transform: "translate(0px, 0px) translate(-50%, -50%) scale(1)" },
    ], resting ? motion.drift : motion.smooth);
  }, [layout]);

  useEffect(() => {
    if (!track) return;
    let cancelled = false;
    const cached = cachedBigscreenArtwork(track);
    if (cached) {
      show(cached, key);
      if (settledBigscreenArtwork(track)) return;
      // A fallback cover stays up while a larger one is looked for again.
      void preloadBigscreenArtwork(track).then((source) => {
        if (!cancelled && source && source !== cached) show(source, key);
      });
      return () => { cancelled = true; };
    }
    // Hold the last cover briefly instead of flashing a blank, then let the thumbnail stand in.
    const timer = setTimeout(() => { if (!cancelled) show(thumbnailArtwork(track), key); }, COVER_WAIT_MS);
    void preloadBigscreenArtwork(track).then((source) => {
      clearTimeout(timer);
      if (!cancelled) show(source ?? thumbnailArtwork(track), key);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, show]);

  const drop = (id: number) => setLayers((current) => current.filter((layer) => layer.id !== id || !layer.leaving));

  return (
    <div id="albumCover" ref={cover} data-active={active} data-layout={layout} data-empty={!track} aria-hidden={!active}>
      {layers.map((layer) => (
        <img
          key={layer.id}
          src={layer.src}
          alt={track && !layer.leaving ? `${track.album} album cover` : ""}
          className="albumCoverImg"
          data-motion={layer.motion}
          data-leaving={layer.leaving}
          style={{ "--direction": layer.direction } as CSSProperties}
          aria-hidden={!track || layer.leaving}
          onAnimationEnd={() => { if (layer.leaving) drop(layer.id); }}
          onError={() => { if (!layer.leaving && layer.src !== whiteArtwork) show(whiteArtwork, layer.album); }}
        />
      ))}
      <img
        src="/ambra.png"
        alt="Ambra"
        className="albumCoverPlaceholder"
        aria-hidden={!!track}
      />
    </div>
  );
}

export function BackgroundArtwork({ track, active, animate, playing, coverId = "albumCover", coverDim = 1, coverDimMs }: BackgroundArtworkProps) {
  const [palette, setPalette] = useState<ArtworkPalette>({
    colors: [SURFACE_BLACK, SURFACE_BLACK, SURFACE_BLACK, SURFACE_BLACK],
    weights: [1, 0, 0, 0],
  });
  const [edges, setEdges] = useState<number[] | null | undefined>();
  // Recomputed when the view's overlay changes, so both views separate the cover by what is visible.
  const separation = useMemo<CoverSeparation>(
    () => edges === undefined
      ? neutralCoverSeparation
      : coverSeparation(edges, palette.colors, palette.weights, coverDim),
    [edges, palette, coverDim],
  );

  useEffect(() => {
    if (!track) return;
    let cancelled = false;

    void Promise.all([
      artworkPalette(track),
      sampleCoverEdges(thumbnailArtwork(track)),
    ]).then(([palette, edges]) => {
      if (!cancelled && palette.colors.length === 4) {
        const colors = separateCollapsedPalette(palette.colors);
        setPalette({ ...palette, colors });
        setEdges(edges);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    track?.albumId,
    track?.cover,
    track?.nativeCover,
    track?.provider,
    track?.upc,
  ]);

  return (
    <div id="backgroundFX" aria-hidden="true" data-active={active} data-empty={!track}>
      <FluidGradientBackground
        colors={palette.colors}
        weights={palette.weights}
        separation={separation}
        coverId={coverId}
        coverDim={coverDim}
        coverDimMs={coverDimMs}
        active={active && !!track}
        animate={track ? animate : false}
        playing={playing}
      />
    </div>
  );
}
