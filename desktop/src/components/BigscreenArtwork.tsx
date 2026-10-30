import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { motion } from "../utils/motion";
import {
  artworkPalette,
  thumbnailArtwork,
  type ArtworkPalette,
} from "../api/server";
import {
  cachedBigscreenArtwork,
  preloadArtwork,
  preloadBigscreenArtwork,
  settledBigscreenArtwork,
} from "../utils/artworkImages";
import type { Track } from "../types/music";
import {
  sampleCoverEdges,
  separateCollapsedPalette,
  separatePaletteFromCover,
  type CoverEdgeSamples,
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
  /** Visible share of the background beside the cover; see separatePaletteFromCover. */
  coverDim?: number;
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
    }
    // Hold the last cover briefly instead of flashing a blank, then let the thumbnail stand in.
    let displayed = !!cached;
    let resolving = true;
    const timer = setTimeout(() => {
      if (!cancelled && !displayed) show(thumbnailArtwork(track), key);
    }, COVER_WAIT_MS);
    // Load the provider's full image alongside the optional cross-service lookup.
    // A slow or failed resolver must never leave a working full-size cover unused.
    const native = track.fullCover ?? track.nativeCover ?? track.cover;
    if (!cached) void preloadArtwork(native, true, { timeoutMs: 10_000 }).then(() => {
      if (!cancelled && resolving) { displayed = true; show(native, key); }
    }).catch(() => {});
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const resolve = async () => {
      const source = await preloadBigscreenArtwork(track);
      if (cancelled) return;
      clearTimeout(timer);
      if (source) { resolving = false; displayed = true; show(source, key); }
      else if (!displayed) show(thumbnailArtwork(track), key);
      if (!settledBigscreenArtwork(track)) {
        retry = setTimeout(() => { void resolve(); }, [1000, 3000, 10_000, 30_000][Math.min(attempt++, 3)]);
      }
    };
    void resolve();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(retry);
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

export function BackgroundArtwork({ track, active, animate, playing, coverDim = 1 }: BackgroundArtworkProps) {
  const [palette, setPalette] = useState<ArtworkPalette>({
    colors: [SURFACE_BLACK, SURFACE_BLACK, SURFACE_BLACK, SURFACE_BLACK],
    weights: [1, 0, 0, 0],
  });
  const [edges, setEdges] = useState<CoverEdgeSamples | null>(null);
  // Recomputed when the view's overlay changes, so both views separate the cover by what is visible.
  const colors = useMemo(
    () => separatePaletteFromCover(palette.colors, edges, coverDim),
    [edges, palette, coverDim],
  );

  useEffect(() => {
    if (!track) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const load = () => void Promise.all([
      artworkPalette(track),
      sampleCoverEdges(thumbnailArtwork(track)),
    ]).then(([palette, edges]) => {
      if (cancelled) return;
      if (palette.colors.length === 4) {
        const colors = separateCollapsedPalette(palette.colors);
        setPalette({ ...palette, colors });
        setEdges(edges);
      } else {
        // A failed request would otherwise leave an earlier song's swirl up for this whole song.
        retry = setTimeout(load, [1000, 3000, 10_000, 30_000][Math.min(attempt++, 3)]);
      }
    });
    load();

    return () => {
      cancelled = true;
      clearTimeout(retry);
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
        colors={colors}
        weights={palette.weights}
        active={active && !!track}
        animate={track ? animate : false}
        playing={playing}
      />
    </div>
  );
}
