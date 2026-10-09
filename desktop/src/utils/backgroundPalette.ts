type Rgb = [number, number, number];

export function softenedPaletteWeights(weights: number[], colorCount: number) {
  const count = Math.min(4, Math.max(1, colorCount));
  // Square roots gently favor common colors while keeping small accents visible.
  const softened = Array.from({ length: 4 }, (_, index) =>
    index < count && Number.isFinite(weights[index]) ? Math.sqrt(Math.max(0, weights[index])) : 0,
  );
  const total = softened.reduce((sum, weight) => sum + weight, 0);
  return total > 0
    ? softened.map((weight) => weight / total)
    : softened.map((_, index) => index < count ? 1 / count : 0);
}

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

export type CoverSeparation = {
  // Per side, in shader order: top, right, bottom, left.
  edges: number[];
  // -1 darkens the background beside that side, 1 lightens it.
  directions: number[];
};

export const neutralCoverSeparation: CoverSeparation = {
  edges: [0.5, 0.5, 0.5, 0.5],
  directions: [0, 0, 0, 0],
};

// Averages the outer band of a small, square RGBA sample of the cover per side.
export function coverEdgeLuminances(pixels: ArrayLike<number>, size: number) {
  const band = Math.max(1, Math.round(size / 8));
  const sides = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const value = luminance([
        pixels[offset] / 255,
        pixels[offset + 1] / 255,
        pixels[offset + 2] / 255,
      ]);
      const add = (side: number) => {
        sides[side] += value;
        counts[side] += 1;
      };
      if (y < band) add(0);
      if (x >= size - band) add(1);
      if (y >= size - band) add(2);
      if (x < band) add(3);
    }
  }
  return sides.map((sum, side) => counts[side] ? sum / counts[side] : 0.5);
}

export function coverSeparation(
  edges: number[] | null,
  colors: string[],
  weights: number[],
): CoverSeparation {
  if (colors.length === 0) return neutralCoverSeparation;
  const influence = softenedPaletteWeights(weights, colors.length);
  const background = colors
    .slice(0, 4)
    .reduce((sum, color, index) => sum + luminance(parseColor(color)) * influence[index], 0);
  // Without a readable cover, its palette is the best guess for every edge.
  const sides = edges?.length === 4 ? edges : [background, background, background, background];
  return {
    edges: sides,
    directions: sides.map((edge) => {
      // Push the way the background already leans; when it doesn't, use the headroom.
      const difference = background - edge;
      if (Math.abs(difference) >= 0.08) return Math.sign(difference);
      return edge > 0.5 ? -1 : 1;
    }),
  };
}
