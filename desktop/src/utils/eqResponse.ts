import type { DspPreset, EqBand } from "./audioSettings";

/** The rate the response is drawn at; the engine builds the same filters for each stream's own rate. */
const RESPONSE_RATE = 48_000;
export const EQ_MIN_HZ = 20;
export const EQ_MAX_HZ = 20_000;

/** The engine's filters (native_audio/dsp.rs uses the biquad crate's RBJ cookbook forms). */
function coefficients(band: EqBand, rate: number) {
  const w0 = (2 * Math.PI * band.frequency) / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * band.q);
  const a = 10 ** (band.gainDb / 40);
  const root = 2 * Math.sqrt(a) * alpha;
  switch (band.kind) {
    case "peak":
      return { b0: 1 + alpha * a, b1: -2 * cos, b2: 1 - alpha * a, a0: 1 + alpha / a, a1: -2 * cos, a2: 1 - alpha / a };
    case "lowShelf":
      return {
        b0: a * ((a + 1) - (a - 1) * cos + root), b1: 2 * a * ((a - 1) - (a + 1) * cos), b2: a * ((a + 1) - (a - 1) * cos - root),
        a0: (a + 1) + (a - 1) * cos + root, a1: -2 * ((a - 1) + (a + 1) * cos), a2: (a + 1) + (a - 1) * cos - root,
      };
    case "highShelf":
      return {
        b0: a * ((a + 1) + (a - 1) * cos + root), b1: -2 * a * ((a - 1) + (a + 1) * cos), b2: a * ((a + 1) + (a - 1) * cos - root),
        a0: (a + 1) - (a - 1) * cos + root, a1: 2 * ((a - 1) - (a + 1) * cos), a2: (a + 1) - (a - 1) * cos - root,
      };
  }
}

/** A band's level change at `frequency`, in dB. Bands the engine skips contribute nothing. */
export function bandResponseDb(band: EqBand, frequency: number, rate = RESPONSE_RATE) {
  if (!band.enabled || band.gainDb === 0 || band.frequency >= rate / 2 || !(band.q > 0)) return 0;
  const { b0, b1, b2, a0, a1, a2 } = coefficients(band, rate);
  const w = (2 * Math.PI * frequency) / rate;
  const [c1, s1, c2, s2] = [Math.cos(w), Math.sin(w), Math.cos(2 * w), Math.sin(2 * w)];
  const numerator = (b0 + b1 * c1 + b2 * c2) ** 2 + (b1 * s1 + b2 * s2) ** 2;
  const denominator = (a0 + a1 * c1 + a2 * c2) ** 2 + (a1 * s1 + a2 * s2) ** 2;
  return 10 * Math.log10(numerator / denominator);
}

/** The whole EQ's level change at `frequency`, before headroom and output gain. */
export function eqResponseDb(bands: readonly EqBand[], frequency: number) {
  return bands.reduce((total, band) => total + bandResponseDb(band, frequency), 0);
}

/** Frequencies spaced evenly on the graph's log axis. */
export function logFrequencies(count = 240) {
  return Array.from({ length: count }, (_, index) => EQ_MIN_HZ * (EQ_MAX_HZ / EQ_MIN_HZ) ** (index / (count - 1)));
}

/** The EQ's largest boost across the audible band; headroom at least this large keeps it from clipping. */
export function maxBoostDb(bands: readonly EqBand[]) {
  return Math.max(0, ...logFrequencies(480).map(frequency => eqResponseDb(bands, frequency)));
}

/** Headroom below the boost the EQ and output gain add, in dB; zero means no clipping is possible. */
export function clippingRiskDb(preset: Pick<DspPreset, "bands" | "headroomDb" | "outputGainDb">) {
  return Math.max(0, maxBoostDb(preset.bands) + preset.outputGainDb - preset.headroomDb);
}
