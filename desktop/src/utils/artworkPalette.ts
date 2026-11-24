import { parseColor, separateCollapsedPalette, type Rgb } from "./backgroundPalette";
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

/** OKLab lightness over which a stretch of rim crossfades from halo to shadow, around the field's own. */
const RIM_CROSSFADE = 0.02;

/**
 * Where each server boundary sample sits around the cover, in degrees clockwise from the top.
 * The server walks eight zones, sampling the top, right, bottom and left rims in each.
 */
const RIM_SAMPLES = Array.from({ length: 32 }, (_, index) => {
  const along = (2 * Math.floor(index / 4) + 1) / 16 - 0.5;
  const [x, y] = [[along, -0.5], [0.5, along], [along, 0.5], [-0.5, along]][index % 4];
  return { index, angle: (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360 };
}).sort((a, b) => a.angle - b.angle);

/** The rim's angles, in the order coverRim lists its strengths. */
export const RIM_ANGLES = RIM_SAMPLES.map(sample => sample.angle);

/** sRGB to OKLab, where distances match how different two colors look, hue included. */
function toOklab(color: Rgb): Rgb {
  const [r, g, b] = color.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(c => {
    const clamped = Math.min(1, Math.max(0, c));
    return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

const smoothstep = (from: number, to: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

export type CoverRim = {
  /** How strongly the shadow and the halo show at each point of the rim, in RIM_ANGLES order. */
  shadow: number[];
  halo: number[];
  shadowTint: Rgb;
  haloTint: Rgb;
};

/**
 * How the cover is lifted off the swirl at each point of its rim (BigscreenArtwork.css). Each
 * stretch of rim gets whichever pushes the field away from its own shade: a shadow beside a
 * stretch lighter than the field, a halo beside a darker one, crossfading where the rim changes
 * so the two never meet at a hard line. Neither ever brings the field to the cover's shade.
 * A stretch whose color already stands apart from the field, by hue as much as by lightness,
 * needs only a trace of either. Both are tinted with the field's hue, so they read as the field
 * itself darkening or catching the cover's light, not as a grey outline.
 */
export function coverRim(palette: ArtworkPalette): CoverRim {
  const total = palette.weights.reduce((sum, weight) => sum + weight, 0);
  const shade = SWIRL_SHADE_MIN + SWIRL_SHADE_RANGE / 2;
  const field = swirlPalette(palette).colors.reduce<Rgb>((sum, color, index) => {
    const share = palette.weights[index] / total * shade;
    return sum.map((channel, at) => channel + parseColor(color)[at] * share) as Rgb;
  }, [0, 0, 0]);
  const fieldLab = toOklab(field);
  const edges = palette.edgeColors;
  const rim = RIM_SAMPLES.map(({ index }) => (edges
    ? [edges[3 * index], edges[3 * index + 1], edges[3 * index + 2]]
    : [1, 1, 1]) as Rgb);
  // Each sample is a single pixel, so neighbours steady it against noise and stray detail.
  const local = rim.map((color, at) => color.map((channel, c) =>
    (rim[(at + rim.length - 1) % rim.length][c] + 2 * channel + rim[(at + 1) % rim.length][c]) / 4) as Rgb);
  const shares = local.map(color => {
    // The glow always pushes the field away from the rim's shade, never toward it: a halo beside
    // a stretch lighter than the field would lift the field through that shade, and the two
    // would blend where they cross. So lighter stretches get a shadow, darker ones a halo.
    return smoothstep(-RIM_CROSSFADE, RIM_CROSSFADE, toOklab(color)[0] - fieldLab[0]);
  });
  const needs = local.map(color => {
    if (!edges) return 1;
    const lab = toOklab(color);
    const distance = Math.hypot(lab[0] - fieldLab[0], lab[1] - fieldLab[1], lab[2] - fieldLab[2]);
    return 1 - 0.65 * smoothstep(0.08, 0.3, distance);
  });
  const [fieldLightness, a, b] = fieldLab;
  return {
    shadow: shares.map((share, at) => share * needs[at]),
    halo: shares.map((share, at) => (1 - share) * needs[at]),
    // Well below the field even when the field is already dark, so the shadow still deepens it.
    shadowTint: fromOklab([Math.min(0.16, fieldLightness * 0.4), a * 0.7, b * 0.7]),
    // A step above the field rather than near-white: over a dark field, white reads as a frame.
    haloTint: fromOklab([Math.min(0.86, fieldLightness + 0.3), a * 0.6, b * 0.6]),
  };
}

/** A mask showing a layer as strongly as `strength` asks at each rim angle, blended between them. */
export function rimMask(strength: number[]) {
  const first = RIM_ANGLES[0];
  const last = RIM_ANGLES[RIM_ANGLES.length - 1];
  const top = strength[strength.length - 1]
    + (strength[0] - strength[strength.length - 1]) * (360 - last) / (360 - last + first);
  const stops = [[0, top], ...RIM_ANGLES.map((angle, index) => [angle, strength[index]]), [360, top]];
  return `conic-gradient(${stops.map(([angle, alpha]) => `rgba(0, 0, 0, ${alpha.toFixed(3)}) ${angle.toFixed(2)}deg`).join(", ")})`;
}
