import { luminance, parseColor, separateCollapsedPalette } from "./backgroundPalette";
import { SWIRL_SHADE_MIN, SWIRL_SHADE_RANGE } from "./swirlShader";

export type ArtworkPalette = {
  colors: string[];
  weights: number[];
  /** Boundary colors sampled once by the server, independent of each client's image decoder. */
  edgeColors?: number[];
};

/** Resolve the original artwork, not a client's thumbnail size or bridge address. */
export function artworkPalettePath(provider: string, nativeCover?: string | null, cover?: string): string | null {
  if (provider === "local") {
    for (const source of [nativeCover, cover]) {
      try {
        const file = new URL(source ?? "", "http://ambra.local").pathname
          .match(/\/api\/music\/local\/files\/([a-f0-9]{64}\.[a-z0-9]{1,8})$/)?.[1];
        if (file) return `/api/music/local/files/${file}/palette`;
      } catch { /* Try the display cover when the original is unavailable. */ }
    }
    return null;
  }
  let url = nativeCover;
  if (!url?.startsWith("https://")) {
    try {
      const displayed = new URL(cover ?? "", "http://ambra.local");
      url = displayed.searchParams.get("url") ?? (displayed.protocol === "https:" ? displayed.href : null);
    } catch { return null; }
  }
  return url?.startsWith("https://")
    ? `/api/artwork/palette?${new URLSearchParams({ provider, url, weighted: "true" })}`
    : null;
}

/** Older servers send four colors without coverage or boundary samples. */
export function parseArtworkPalette(value: unknown): ArtworkPalette | null {
  const palette = (Array.isArray(value)
    ? { colors: value, weights: value.map(() => 1 / value.length) }
    : value) as ArtworkPalette | null;
  if (!palette || !Array.isArray(palette.colors) || palette.colors.length !== 4
    || !palette.colors.every(color => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))
    || !Array.isArray(palette.weights) || palette.weights.length !== 4
    || !palette.weights.every(weight => Number.isFinite(weight) && weight >= 0)
    || !palette.weights.some(weight => weight > 0)) return null;
  const edges = palette.edgeColors;
  return {
    colors: palette.colors,
    weights: palette.weights,
    ...(Array.isArray(edges) && edges.length === 96 && edges.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1)
      ? { edgeColors: edges } : {}),
  };
}

/**
 * The swirl is drawn from the cover's own colors, unaltered, so it always matches the cover.
 * Only a cover too uniform to swirl at all gets its shades spread apart. The cover stands out
 * through the field's lower tone (swirlShader.ts) and its own shadow or halo, never by recoloring.
 */
export function swirlPalette(palette: ArtworkPalette): ArtworkPalette {
  return { ...palette, colors: separateCollapsedPalette(palette.colors) };
}

/** How much of the field's brightness is left at the cover's rim under the full shadow. */
const SHADOW_RIM = 0.68;
/** How far the full halo lifts the field at the cover's rim, as a share of the way to white. */
const HALO_LIFT = 0.15;

/**
 * How much of the cover's separation the dark shadow carries, from 0 to 1; a soft light halo
 * carries the rest (BigscreenArtwork.css). A shadow only lifts a cover whose rim is brighter
 * than the darkened field around it; a dark rim sinks into it, and lighter surroundings show
 * that rim instead. Whichever leaves more contrast at the rim wins, with a short crossfade.
 */
export function coverShadowShare(palette: ArtworkPalette): number {
  const edges = palette.edgeColors;
  if (!edges) return 1;
  let rim = 0;
  for (let index = 0; index < edges.length; index += 3) {
    rim += luminance([edges[index], edges[index + 1], edges[index + 2]]);
  }
  rim /= edges.length / 3;
  const total = palette.weights.reduce((sum, weight) => sum + weight, 0);
  const field = swirlPalette(palette).colors.reduce(
    (sum, color, index) => sum + luminance(parseColor(color)) * palette.weights[index], 0,
  ) / total * (SWIRL_SHADE_MIN + SWIRL_SHADE_RANGE / 2);
  const withShadow = rim - field * SHADOW_RIM;
  const withHalo = field + (1 - field) * HALO_LIFT - rim;
  const share = Math.min(1, Math.max(0, (withShadow - withHalo + 0.05) / 0.1));
  return share * share * (3 - 2 * share);
}
