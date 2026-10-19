import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { compactArtworkRect } from "../utils/compactArtwork";
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

const FLIGHT_MS = 650;
const FLIGHT_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
/** The cover's own centring, which every flight transform builds on. */
const CENTRED = "translate(-50%, -50%)";

/** Moves and scales the cover's box onto another box, measured from its resting place. */
function flightTransform(from: DOMRect, to: DOMRect) {
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  return `${CENTRED} translate(${dx}px, ${dy}px) scale(${to.width / from.width})`;
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

  // Opening grows the cover out of the now-playing bar's thumbnail; closing shrinks it back in.
  const cover = useRef<HTMLDivElement>(null);
  const wasActive = useRef(active);
  const [closing, setClosing] = useState(false);
  useLayoutEffect(() => {
    const element = cover.current;
    const opened = active && !wasActive.current;
    const closed = !active && wasActive.current;
    wasActive.current = active;
    if (!element || (!opened && !closed) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const thumbnail = compactArtworkRect();
    const home = element.getBoundingClientRect();
    if (!thumbnail || !home.width || !thumbnail.width) return;
    const shrunk = flightTransform(home, thumbnail);
    if (opened) {
      const flight = element.animate([{ transform: shrunk, opacity: 0.6 }, { transform: CENTRED, opacity: 1 }], { duration: FLIGHT_MS, easing: FLIGHT_EASE });
      return () => flight.cancel();
    }
    setClosing(true);
    document.documentElement.dataset.coverFlight = "closing";
    const flight = element.animate([{ transform: CENTRED }, { transform: shrunk }], { duration: FLIGHT_MS * 0.85, easing: FLIGHT_EASE, fill: "forwards" });
    const land = () => {
      flight.cancel();
      setClosing(false);
      delete document.documentElement.dataset.coverFlight;
    };
    flight.onfinish = land;
    return () => {
      flight.onfinish = null;
      land();
    };
  }, [active]);

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
    <div id="albumCover" ref={cover} data-active={active} data-closing={closing} data-layout={layout} data-empty={!track} aria-hidden={!active}>
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
