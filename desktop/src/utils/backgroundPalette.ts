import { perceptualColor, srgbFromPerceptual } from "./perceptualColor";

type Rgb = [number, number, number];

function parseColor(color: string): Rgb {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return [0, 0, 0];
  return [1, 3, 5].map(
    (offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255,
  ) as Rgb;
}

function luminance([red, green, blue]: Rgb) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function colorDistance(left: Rgb, right: Rgb) {
  return Math.sqrt(
    left.reduce((sum, channel, index) => {
      const difference = channel - right[index];
      return sum + difference * difference;
    }, 0),
  );
}

function toHex(color: Rgb) {
  return `#${color
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function separateCollapsedPalette(colors: string[]) {
  if (colors.length !== 4) return colors;
  const parsed = colors.map(parseColor);
  const widestDistance = parsed.reduce(
    (widest, color, index) =>
      Math.max(
        widest,
        ...parsed.slice(index + 1).map((other) => colorDistance(color, other)),
      ),
    0,
  );
  if (widestDistance >= 0.18) return colors;

  const averageLuminance =
    parsed.reduce((sum, color) => sum + luminance(color), 0) / parsed.length;
  const targetLuminance = averageLuminance >= 0.5
    ? Math.max(0.38, averageLuminance - 0.14)
    : Math.min(0.62, averageLuminance + 0.12);
  const mixWithWhite = targetLuminance > averageLuminance;
  const amount = mixWithWhite
    ? (targetLuminance - averageLuminance) / (1 - averageLuminance)
    : 1 - targetLuminance / averageLuminance;

  return parsed.map((color) =>
    toHex(
      color.map((channel) =>
        mixWithWhite
          ? channel + (1 - channel) * amount
          : channel * (1 - amount),
      ) as Rgb,
    ),
  );
}

// The swirl's saturation boost and per-pixel shade range (swirlShader.ts main()).
// Shared so the palette is separated from the cover as the field actually draws it.
export const SWIRL_SATURATION = 1.18;
export const SWIRL_SHADE_MIN = 0.84;
export const SWIRL_SHADE_RANGE = 0.22;

// Each side of the cover is sampled at this many points along its length.
export const COVER_EDGE_ZONES = 8;

/** Display sRGB boundary samples, three channels each, four sides per zone. */
export type CoverEdgeSamples = { colors: number[] };

const EDGE_SAMPLE_SIZE = 64;

/**
 * Keep actual boundary colors instead of averaging a wide band into colors that
 * may never occur on the edge. Contrast is tested per sample before any blending.
 */
export function coverEdgeSamples(pixels: ArrayLike<number>, size: number): CoverEdgeSamples {
  const colors: number[] = [];
  for (let zone = 0; zone < COVER_EDGE_ZONES; zone++) {
    const along = Math.min(size - 1, Math.floor((zone + 0.5) * size / COVER_EDGE_ZONES));
    for (const [x, y] of [[along, 0], [size - 1, along], [along, size - 1], [0, along]]) {
      const offset = (y * size + x) * 4;
      colors.push(pixels[offset] / 255, pixels[offset + 1] / 255, pixels[offset + 2] / 255);
    }
  }
  return { colors };
}

// Reads how bright each side of the cover is. Covers the webview may not read
// back (no CORS) resolve to null and fall back to the palette.
export function sampleCoverEdges(source: string): Promise<CoverEdgeSamples | null> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  // Wait for load, not decode(): Chromium settles decode() with a rendered frame,
  // which never comes while the window is hidden or covered by a fullscreen game.
  return new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = reject;
    image.src = source;
  }).then(() => {
    const canvas = document.createElement("canvas");
    canvas.width = EDGE_SAMPLE_SIZE;
    canvas.height = EDGE_SAMPLE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, EDGE_SAMPLE_SIZE, EDGE_SAMPLE_SIZE);
    const { data } = context.getImageData(0, 0, EDGE_SAMPLE_SIZE, EDGE_SAMPLE_SIZE);
    return coverEdgeSamples(data, EDGE_SAMPLE_SIZE);
  }).catch(() => null);
}

/** Perceptual (Oklab) distance an edge sample needs from the field to stay distinct.
 * Display levels are sparse near black, so a dark edge needs a larger step. */
const neededContrast = (lightness: number) => Math.max(0.07, 0.16 - lightness);
/** Field shades checked across the swirl's per-pixel brightness range. */
const SWIRL_SHADES = [0, 0.25, 0.5, 0.75, 1].map(step => SWIRL_SHADE_MIN + SWIRL_SHADE_RANGE * step);
const LIGHTNESS_STEP = 0.0025;
/** A moved color keeps at least this share of its original gap above the darker colors. */
const KEEP_SPACING = 0.5;

/**
 * Separates the cover from the swirl by choosing the swirl's colors, not by
 * painting anything near the cover. Each palette color keeps its hue and moves
 * in lightness only as far as needed so that, at every brightness the swirl
 * draws it, it stays perceptually distinct from every sampled edge color.
 * Colors that already contrast are returned unchanged. Lighter colors stay
 * lighter than darker ones, so the swirl keeps its own light and dark.
 *
 * Nothing changes near the cover, so nothing draws the eye to its edges: the
 * swirl is simply made of colors that never match the cover's border.
 *
 * `coverDim` is the share of the background still visible beside the cover
 * after any overlay drawn over the field but under the cover (1 = none).
 */
export function separatePaletteFromCover(colors: string[], edges: CoverEdgeSamples | null, coverDim = 1): string[] {
  // Leave the field alone when the actual boundary is unavailable: a palette
  // alone cannot tell whether a particular edge needs any treatment.
  if (!edges || edges.colors.length !== COVER_EDGE_ZONES * 4 * 3 || colors.length === 0) return colors;
  const dim = Math.min(1, Math.max(0.05, coverDim));
  const targets = Array.from({ length: COVER_EDGE_ZONES * 4 }, (_, index) => {
    const lab = perceptualColor(edges.colors.slice(index * 3, index * 3 + 3));
    return { lab, needed: neededContrast(lab[0]) };
  });
  // How far a palette color, as the swirl draws it, stays beyond the contrast each edge needs.
  const clearance = (rgb: number[]) => {
    const gray = luminance(rgb as Rgb);
    const vivid = rgb.map(channel => gray + (channel - gray) * SWIRL_SATURATION);
    let least = Infinity;
    for (const shade of SWIRL_SHADES) {
      const lab = perceptualColor(vivid.map(channel => dim * Math.min(1, Math.max(0, channel * shade))));
      for (const target of targets) {
        least = Math.min(least, Math.hypot(lab[0] - target.lab[0], lab[1] - target.lab[1], lab[2] - target.lab[2]) - target.needed);
      }
    }
    return least;
  };

  const parsed = colors.map(parseColor);
  const original = parsed.map(rgb => perceptualColor(rgb));
  const result = [...colors];
  let lower: { from: number; to: number } | null = null;
  for (const index of parsed.map((_, index) => index).sort((a, b) => original[a][0] - original[b][0])) {
    const [lightness, a, b] = original[index];
    const floor = lower ? lower.to + KEEP_SPACING * (lightness - lower.from) : 0;
    // Same hue and saturation at another lightness.
    const at = (target: number) => {
      const scale = lightness > 0.001 ? target / lightness : 0;
      return srgbFromPerceptual([target, a * scale, b * scale]);
    };
    let chosen = lightness;
    if (lightness < floor || clearance(parsed[index]) < 0) {
      // The nearest lightness that works, searching outward; failing that, the most distinct one.
      let best = { lightness, clearance: -Infinity };
      chosen = NaN;
      for (let step = 0; step * LIGHTNESS_STEP <= 1 && Number.isNaN(chosen); step++) {
        for (const candidate of [lightness + step * LIGHTNESS_STEP, lightness - step * LIGHTNESS_STEP]) {
          if (candidate < floor || candidate < 0 || candidate > 1) continue;
          const margin = clearance(at(candidate));
          if (margin >= 0) { chosen = candidate; break; }
          if (margin > best.clearance) best = { lightness: candidate, clearance: margin };
        }
      }
      if (Number.isNaN(chosen)) chosen = best.lightness;
      result[index] = toHex(at(chosen) as Rgb);
    }
    lower = { from: lightness, to: chosen };
  }
  return result;
}
