import { separateCollapsedPalette, separatePaletteFromCover } from "./backgroundPalette";

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

/** Every renderer uses the same cover contrast, regardless of view or screen size. */
export function swirlPalette(palette: ArtworkPalette): ArtworkPalette {
  return {
    ...palette,
    colors: separatePaletteFromCover(separateCollapsedPalette(palette.colors),
      palette.edgeColors ? { colors: palette.edgeColors } : null),
  };
}
