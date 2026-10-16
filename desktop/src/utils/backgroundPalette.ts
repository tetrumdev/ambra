import { swirlShares } from "./swirlProportions";

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
};

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

/**
 * `coverDim` is the share of the background still visible beside the cover
 * after any overlay drawn over the field but under the cover (1 = none).
 */
export function coverSeparation(
  edges: number[] | null,
  colors: string[],
  weights: number[],
  coverDim = 1,
): CoverSeparation {
  if (colors.length === 0) return neutralCoverSeparation;
  // The background shows each color in about its swirl share.
  const influence = swirlShares(weights.slice(0, colors.length));
  const background = coverDim * colors
    .slice(0, 4)
    .reduce((sum, color, index) => sum + luminance(parseColor(color)) * influence[index], 0);
  // Without a readable cover, its palette is the best guess for every edge.
  const zones = edges?.length === COVER_EDGE_ZONES * 4
    ? edges
    : Array(COVER_EDGE_ZONES * 4).fill(background);
  return {
    edges: zones,
    directions: zones.map((edge) => {
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
