import { swirlShares } from "./swirlProportions";
import { linearChannel, perceptualColor } from "./perceptualColor";

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

// Each side of the cover is measured in this many zones along its length.
export const COVER_EDGE_ZONES = 8;

export type CoverSeparation = {
  // Zone-major, each zone in shader order: top, right, bottom, left. Zones run
  // left to right along the top and bottom, top to bottom along the sides.
  edges: number[];
  // -1 darkens the background beside that zone, 1 lightens it.
  directions: number[];
  /** Actual RGB boundary samples, in the same zone/side order as edges. */
  colors?: number[];
};

export type CoverEdgeSamples = { luminances: number[]; colors: number[] };

export const neutralCoverSeparation: CoverSeparation = {
  edges: Array(COVER_EDGE_ZONES * 4).fill(0.5),
  directions: Array(COVER_EDGE_ZONES * 4).fill(0),
};

// Averages the outer band of a small, square RGBA sample of the cover per zone.
export function coverEdgeLuminances(pixels: ArrayLike<number>, size: number) {
  const band = Math.max(1, Math.round(size / 8));
  const zones = Array(COVER_EDGE_ZONES * 4).fill(0);
  const counts = Array(COVER_EDGE_ZONES * 4).fill(0);
  const zoneOf = (position: number) =>
    Math.min(COVER_EDGE_ZONES - 1, Math.floor((position / size) * COVER_EDGE_ZONES));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const value = luminance([
        pixels[offset] / 255,
        pixels[offset + 1] / 255,
        pixels[offset + 2] / 255,
      ]);
      const add = (side: number, position: number) => {
        const index = zoneOf(position) * 4 + side;
        zones[index] += value;
        counts[index] += 1;
      };
      if (y < band) add(0, x);
      if (x >= size - band) add(1, y);
      if (y >= size - band) add(2, x);
      if (x < band) add(3, y);
    }
  }
  return zones.map((sum, index) => counts[index] ? sum / counts[index] : 0.5);
}

const EDGE_SAMPLE_SIZE = 64;

/**
 * Keep actual boundary colors instead of averaging a wide band into colors that
 * may never occur on the edge. Contrast is tested per sample before any blending.
 */
export function coverEdgeSamples(pixels: ArrayLike<number>, size: number): CoverEdgeSamples {
  const colors: number[] = [];
  const luminances: number[] = [];
  for (let zone = 0; zone < COVER_EDGE_ZONES; zone++) {
    const along = Math.min(size - 1, Math.floor((zone + 0.5) * size / COVER_EDGE_ZONES));
    for (const [x, y] of [[along, 0], [size - 1, along], [along, size - 1], [0, along]]) {
      const offset = (y * size + x) * 4;
      const rgb: Rgb = [pixels[offset] / 255, pixels[offset + 1] / 255, pixels[offset + 2] / 255];
      colors.push(...rgb);
      luminances.push(luminance(rgb));
    }
  }
  return { luminances, colors };
}

// Reads how bright each side of the cover is. Covers the webview may not read
// back (no CORS) resolve to null and fall back to the palette.
export function sampleCoverEdges(source: string): Promise<CoverEdgeSamples | null> {
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
    return coverEdgeSamples(data, EDGE_SAMPLE_SIZE);
  }).catch(() => null);
}

/**
 * `coverDim` is the share of the background still visible beside the cover
 * after any overlay drawn over the field but under the cover (1 = none).
 */
export function coverSeparation(
  edges: CoverEdgeSamples | number[] | null,
  colors: string[],
  weights: number[],
  coverDim = 1,
): CoverSeparation {
  if (colors.length === 0 || !edges) return neutralCoverSeparation;
  // The background shows each color in about its swirl share.
  const influence = swirlShares(weights.slice(0, colors.length));
  const background = coverDim * colors
    .slice(0, 4)
    .reduce((sum, color, index) => sum + luminance(parseColor(color)) * influence[index], 0);
  // Without a readable cover, its palette is the best guess for every edge.
  // A palette alone cannot tell whether a particular edge needs any treatment.
  // Leave the field alone when the actual boundary is unavailable.
  const samples = Array.isArray(edges) ? edges : edges.luminances;
  if (samples.length !== COVER_EDGE_ZONES * 4) return neutralCoverSeparation;
  const zones = samples;
  return {
    edges: zones,
    colors: Array.isArray(edges) ? zones.flatMap(value => [value, value, value]) : edges.colors,
    directions: zones.map((edge, index) => {
      // Saturated colors can have low weighted luma while a primary channel is
      // already near its ceiling. Darken those edges instead of clipping a lift.
      const rgb = Array.isArray(edges) ? [edge, edge, edge] : edges.colors.slice(index * 3, index * 3 + 3);
      const lightness = perceptualColor(rgb)[0];
      const lightnessLimit = lightness > 0.0001
        ? lightness * Math.cbrt(linearChannel(coverDim) / Math.max(0.000001, linearChannel(Math.max(...rgb))))
        : Math.cbrt(linearChannel(coverDim));
      if (lightnessLimit - lightness < 0.075) return -1;
      // Edges too near either extreme leave room to move only one way.
      if (edge < 0.14) return 1;
      if (edge > 0.86) return -1;
      // Push the way the background already leans; when it doesn't, cast a shadow
      // unless the edge is too dark for one to show.
      const difference = background - edge;
      if (Math.abs(difference) >= 0.08) return Math.sign(difference);
      return edge > 0.2 ? -1 : 1;
    }),
  };
}
