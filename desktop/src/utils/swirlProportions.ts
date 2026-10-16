// The swirl blends four noise fields with a softmax, which on its own gives each
// palette color about a quarter of the background whatever its share of the cover.
// Each field gets a bias, calibrated against a CPU replica of the shader's fields,
// so the colors' average blend weights follow the cover instead.

/** Must match the field sharpness in FluidGradientBackground's fragment shader. */
export const SWIRL_SHARPNESS = 9;
const LATTICE_SIZE = 256;
const SAMPLE_COUNT = 1500;
/** Proportions are slightly tempered so a small accent still reads as part of the cover. */
const SHARE_EXPONENT = 0.9;
const MINIMUM_SHARE = 0.04;
/** Puts an unused palette slot (zero coverage) out of reach of the blend. */
const UNUSED_BIAS = -1;

let samples: Float64Array | null = null;
const biasCache = new Map<string, number[]>();

function fieldSamples() {
  if (samples) return samples;
  // Statistics, not the exact picture, matter here; any uniform lattice will do.
  const lattice = new Float64Array(LATTICE_SIZE * LATTICE_SIZE);
  let state = 0x2f6b1d;
  for (let index = 0; index < lattice.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    lattice[index] = (state >>> 24) / 255;
  }
  const at = (x: number, y: number) =>
    lattice[(y & (LATTICE_SIZE - 1)) * LATTICE_SIZE + (x & (LATTICE_SIZE - 1))];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const noise = (x: number, y: number) => {
    const cellX = Math.floor(x);
    const cellY = Math.floor(y);
    const fadeX = fade(x - cellX);
    const fadeY = fade(y - cellY);
    const bottom = at(cellX, cellY) + (at(cellX + 1, cellY) - at(cellX, cellY)) * fadeX;
    const top = at(cellX, cellY + 1) + (at(cellX + 1, cellY + 1) - at(cellX, cellY + 1)) * fadeX;
    return bottom + (top - bottom) * fadeY;
  };
  const fbm = (x: number, y: number) => {
    let value = 0;
    let amplitude = 0.5;
    for (let octave = 0; octave < 5; octave++) {
      value += amplitude * noise(x, y);
      // GLSL's column-major mat2(0.80, -0.60, 0.60, 0.80) applied to (x, y).
      [x, y] = [(0.8 * x + 0.6 * y) * 2.03 + 7.13, (-0.6 * x + 0.8 * y) * 2.03 + 7.13];
      amplitude *= 0.5;
    }
    return value;
  };

  samples = new Float64Array(SAMPLE_COUNT * 4);
  let random = 0x51ed27;
  const next = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random / 2 ** 32;
  };
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    // A wide window at typical aspect ratios, over a long stretch of swirl time.
    const x = (next() - 0.5) * 1.8;
    const y = next() - 0.5;
    const time = next() * 3000 * 0.055;
    const warpX = fbm(x * 1.15 + time, y * 1.15 - time * 0.72);
    const warpY = fbm(x * 1.15 + 4.3 - time * 0.61, y * 1.15 + 1.7 + time);
    const secondX = fbm(x * 1.8 + warpX * 1.7 + 8.1, y * 1.8 + warpY * 1.7 + time * 0.46);
    const secondY = fbm(x * 1.8 + warpX * 1.7 - 2.4 - time * 0.4, y * 1.8 + warpY * 1.7 + 5.2);
    const fluidX = x + (warpX - 0.5) * 0.95 + (secondX - 0.5) * 0.4;
    const fluidY = y + (warpY - 0.5) * 0.95 + (secondY - 0.5) * 0.4;
    samples.set([
      fbm(fluidX * 1.25, fluidY * 1.25 + time),
      fbm(fluidX * 1.31 + 5.7 + time * 0.7, fluidY * 1.31 - 3.1),
      fbm(fluidX * 1.18 - 4.2, fluidY * 1.18 + 6.8 - time * 0.83),
      fbm(fluidX * 1.38 + 2.6 - time * 0.52, fluidY * 1.38 - 7.4 + time * 0.35),
    ], sample * 4);
  }
  return samples;
}

/** Average blend weight of each color across the sampled field. */
function blendShares(biases: number[]) {
  const fields = fieldSamples();
  const shares = [0, 0, 0, 0];
  const weights = [0, 0, 0, 0];
  for (let offset = 0; offset < fields.length; offset += 4) {
    let highest = -Infinity;
    for (let index = 0; index < 4; index++) highest = Math.max(highest, fields[offset + index] + biases[index]);
    let total = 0;
    for (let index = 0; index < 4; index++) {
      weights[index] = Math.exp((fields[offset + index] + biases[index] - highest) * SWIRL_SHARPNESS);
      total += weights[index];
    }
    for (let index = 0; index < 4; index++) shares[index] += weights[index] / total;
  }
  return shares.map((share) => share / SAMPLE_COUNT);
}

/** Each palette color's intended share of the swirl. */
export function swirlShares(weights: number[]) {
  const coverage = Array.from({ length: 4 }, (_, index) => {
    const weight = weights[index];
    return Number.isFinite(weight) && weight > 0 ? weight ** SHARE_EXPONENT : 0;
  });
  const total = coverage.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return [0.25, 0.25, 0.25, 0.25];
  const raised = coverage.map((value) => value > 0 ? Math.max(MINIMUM_SHARE, value / total) : 0);
  const raisedTotal = raised.reduce((sum, value) => sum + value, 0);
  return raised.map((value) => value / raisedTotal);
}

/** Per-field biases that give each palette color about its share of the cover. */
export function swirlBiases(weights: number[]): number[] {
  const targets = swirlShares(weights);
  const used = targets.map((share) => share > 0);
  const biases = targets.map((share) => share > 0 ? 0 : UNUSED_BIAS);
  // A single color needs no calibration (and skips sampling for the initial black field).
  if (used.filter(Boolean).length < 2) return biases;
  const key = targets.map((share) => share.toFixed(3)).join(":");
  const cached = biasCache.get(key);
  if (cached) return cached;

  for (let iteration = 0; iteration < 40; iteration++) {
    const shares = blendShares(biases);
    for (let index = 0; index < 4; index++) {
      if (used[index]) biases[index] += 0.8 * Math.log(targets[index] / Math.max(shares[index], 1e-6)) / SWIRL_SHARPNESS;
    }
    // Only differences matter; anchor the largest used bias at zero.
    const highest = Math.max(...biases.filter((_, index) => used[index]));
    for (let index = 0; index < 4; index++) if (used[index]) biases[index] -= highest;
  }
  biasCache.set(key, biases);
  if (biasCache.size > 64) biasCache.delete(biasCache.keys().next().value!);
  return biases;
}
