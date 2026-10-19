import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { compactArtworkRect } from "../utils/compactArtwork";
import { motion } from "../utils/motion";
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
  track: Track | undefined;
};

type BackgroundArtworkProps = ArtworkProps & {
  active: boolean;
  animate?: boolean;
  playing?: boolean;
  coverId?: string;
  /** Visible share of the background beside the cover; see coverSeparation. */
  coverDim?: number;
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

type CoverLayer = {
  id: number;
  src: string;
  /** Which album the image belongs to; a different album slides, a sharper copy of the same one fades. */
  album: string;
  motion: "none" | "fade" | "slide";
  direction: number;
  leaving: boolean;
};

/** The cover's own centring, which every flight transform builds on. */
const CENTRED = "translate(-50%, -50%)";
/** The bar thumbnail's corner radius (#compactArtwork), which the cover takes on as it lands. */
const THUMBNAIL_RADIUS = 8;
/** How far the cover's images overhang its box to the right and bottom (.albumCoverImg). */
const IMAGE_OVERHANG = 2;

/** Moves and scales the cover's resting box onto another box on screen. */
function flightFrame(home: DOMRect, to: DOMRect, thumbnail: DOMRect) {
  const dx = to.left + to.width / 2 - (home.left + home.width / 2);
  const dy = to.top + to.height / 2 - (home.top + home.height / 2);
  const scale = to.width / home.width;
  // Rounds the corners in step with the shrink, so they match the thumbnail's on screen when it lands.
  // The clip leaves the images' overhang showing, so the resting frame matches the cover once the flight ends.
  const landed = Math.min(1, Math.max(0, (1 - scale) / (1 - thumbnail.width / home.width)));
  const radius = (landed * THUMBNAIL_RADIUS) / scale;
  return { transform: `${CENTRED} translate(${dx}px, ${dy}px) scale(${scale})`, clipPath: `inset(0 -${IMAGE_OVERHANG}px -${IMAGE_OVERHANG}px 0 round ${radius}px)` };
}

const albumKey = (track: Track) => JSON.stringify([track.provider, track.albumId, track.cover, track.nativeCover, track.upc]);
/** How long a song's cover may load before a smaller copy stands in for it. */
const COVER_WAIT_MS = 500;

export function AlbumArtwork({ track, active, layout = "center", direction }: ArtworkProps & {
  active: boolean;
  layout?: "center" | "lyrics";
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

  // Opening grows the cover out of the now-playing bar's thumbnail while the rest of the
  // player rises in; closing shrinks it back into the thumbnail while the rest sinks away.
  // The flight is driven outside React so the handoff to the thumbnail lands in one frame.
  const cover = useRef<HTMLDivElement>(null);
  // The move and the corner rounding run as separate animations, so the move stays off the
  // main thread (a clip-path keyframe would pull it on) and busy frames can't make it skip.
  const flight = useRef<Animation[]>([]);
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    const element = cover.current;
    const opened = active && !wasActive.current;
    const closed = !active && wasActive.current;
    wasActive.current = active;
    if (!element || (!opened && !closed)) return;
    const root = document.documentElement;
    // Turning back mid-flight picks up from wherever the cover is on screen.
    const midFlight = flight.current.length ? element.getBoundingClientRect() : null;
    for (const animation of flight.current) animation.cancel();
    flight.current = [];
    const land = () => {
      for (const animation of flight.current) animation.cancel();
      flight.current = [];
      delete element.dataset.flight;
      delete root.dataset.coverFlight;
    };
    const thumbnail = compactArtworkRect();
    const home = element.getBoundingClientRect();
    if (!thumbnail?.width || !home.width || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      land();
      return;
    }
    const resting = flightFrame(home, home, thumbnail);
    const shrunk = flightFrame(home, thumbnail, thumbnail);
    const start = midFlight ? flightFrame(home, midFlight, thumbnail) : opened ? shrunk : resting;
    element.dataset.flight = opened ? "opening" : "closing";
    if (closed) root.dataset.coverFlight = "closing";
    else delete root.dataset.coverFlight;
    const end = opened ? resting : shrunk;
    // Opening moves with the rest of the player; closing, the cover darts most of the way to the thumbnail, then eases in.
    const timing: KeyframeAnimationOptions = { ...(opened ? motion.smooth : motion.dock), fill: "forwards" };
    const move = element.animate([{ transform: start.transform }, { transform: end.transform }], timing);
    const corners = element.animate([{ clipPath: start.clipPath }, { clipPath: end.clipPath }], timing);
    flight.current = [move, corners];
    // The cover hides and the thumbnail shows in the same frame, so nothing blinks or jumps.
    // Closing, the cover holds on the thumbnail until its image is decoded and ready to show.
    const thumbnailImage = closed ? document.querySelector<HTMLImageElement>("#compactArtwork img") : null;
    const ready = thumbnailImage ? thumbnailImage.decode().catch(() => undefined) : Promise.resolve();
    move.onfinish = () => { void ready.then(() => { if (flight.current[0] === move) land(); }); };
  }, [active]);
  useEffect(() => () => {
    for (const animation of flight.current) animation.cancel();
    delete document.documentElement.dataset.coverFlight;
  }, []);

  useEffect(() => {
    if (!track) return;
    let cancelled = false;
    const cached = cachedBigscreenArtwork(track);
    if (cached) {
      show(cached, key);
      return;
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

export function BackgroundArtwork({ track, active, animate, playing, coverId = "albumCover", coverDim = 1 }: BackgroundArtworkProps) {
  const [palette, setPalette] = useState<ArtworkPalette>({
    colors: ["#000000", "#000000", "#000000", "#000000"],
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
        active={active && !!track}
        animate={track ? animate : false}
        playing={playing}
      />
    </div>
  );
}
