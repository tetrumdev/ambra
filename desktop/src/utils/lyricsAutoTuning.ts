import { getPersistentItem, setPersistentItem } from "./persistentStorage";

/**
 * Auto-sync sensitivity, learned from how the listener corrects it.
 *
 * Each analysis yields a best shift and how strongly it stands out. Whether that is
 * trusted used to be fixed thresholds; instead, every song the listener retimes (or
 * watches without retiming) becomes a sample of where the lyrics really belong, and
 * the thresholds and any steady lag are re-fit to those samples.
 */

/** What one analysis found, before deciding whether to trust it. */
export type OffsetEvidence = {
  /** Milliseconds to add to the lyric offset at the best match; null when nothing could be scored. */
  bestMs: number | null;
  prominence: number;
  /** Lead over the strongest rival peak; null when there is no rival. */
  margin: number | null;
  /** Playback milliseconds where the singing stops; null when the recording can't tell. */
  vocalEndMs?: number | null;
};

export type AutoSyncTuning = {
  minProminence: number;
  minMargin: number;
  /** Added to every detected shift, for a lag the listener corrects on every song. */
  biasMs: number;
};

export const defaultTuning: AutoSyncTuning = { minProminence: 4, minMargin: 0.75, biasMs: 0 };

/** Shifts smaller than this are left alone; they are within what a listener notices. */
const MIN_CORRECTION_MS = 150;
/** A detection within this of where the listener settled counts as right; nudges move in 100 ms steps. */
const MATCH_TOLERANCE_MS = 250;
/** Samples needed before the thresholds move away from the defaults. */
const MIN_SAMPLES = 5;
/** Samples needed before a steady lag is corrected for. */
const MIN_BIAS_SAMPLES = 4;
const MAX_BIAS_MS = 400;
/** A wrong jump is worse than leaving the original timing, so it costs more. */
const FALSE_ACCEPT_COST = 2;
const MISSED_COST = 1;
/** Pulls the fit towards the defaults, so a handful of songs only nudges it. */
const PRIOR_WEIGHT = 0.15;
/** Retiming a song is direct evidence; watching without retiming is weaker. */
const EDIT_WEIGHT = 1;
const WATCH_WEIGHT = 0.5;

const prominenceSteps = Array.from({ length: 23 }, (_, i) => 2.5 + i * 0.25);
const marginSteps = Array.from({ length: 9 }, (_, i) => i * 0.25);

export type SyncSample = OffsetEvidence & {
  /** Identifies the lyric timing the sample was taken against. */
  timing: string;
  /** Where the listener left the timing, as milliseconds added to the lyric offset. */
  finalMs: number;
  edited: boolean;
};

const storageKey = "ambra.lyrics-autosync-samples.v1";
const MAX_SAMPLES = 500;

function readSamples(): Record<string, SyncSample> {
  try {
    const value: unknown = JSON.parse(getPersistentItem(storageKey) ?? "{}");
    if (typeof value !== "object" || value === null) return {};
    const samples: Record<string, SyncSample> = {};
    for (const [trackId, entry] of Object.entries(value)) {
      if (typeof entry !== "object" || entry === null) continue;
      const { timing, bestMs, prominence, margin, finalMs, edited } = entry as Record<string, unknown>;
      if (typeof timing !== "string" || typeof finalMs !== "number" || !Number.isFinite(finalMs)) continue;
      if (typeof bestMs !== "number" || typeof prominence !== "number") continue;
      samples[trackId] = {
        timing,
        bestMs,
        prominence,
        margin: typeof margin === "number" ? margin : null,
        finalMs,
        edited: edited === true,
      };
    }
    return samples;
  } catch {
    return {};
  }
}

let cachedTuning: AutoSyncTuning | null = null;

/**
 * Records where the listener left this song's timing. An edit is never downgraded by a
 * later viewing, and resetting the timing withdraws the sample.
 */
export function recordSyncSample(trackId: string, sample: SyncSample | null) {
  const samples = readSamples();
  const previous = samples[trackId];
  delete samples[trackId];
  if (sample) {
    if (sample.bestMs === null) return;
    const edited = sample.edited || (previous?.timing === sample.timing && previous.edited);
    samples[trackId] = { ...sample, edited };
  } else if (!previous) {
    return;
  }
  const trackIds = Object.keys(samples);
  for (const stale of trackIds.slice(0, Math.max(0, trackIds.length - MAX_SAMPLES))) delete samples[stale];
  try {
    setPersistentItem(storageKey, JSON.stringify(samples));
  } catch (error) {
    console.warn("Could not save lyric auto-sync feedback:", error);
  }
  cachedTuning = null;
}

const accepts = (evidence: OffsetEvidence, minProminence: number, minMargin: number) =>
  evidence.bestMs !== null &&
  evidence.prominence >= minProminence &&
  (evidence.margin === null || evidence.margin >= minMargin);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function fitTuning(samples: SyncSample[]): AutoSyncTuning {
  // A steady gap between the detector and where the listener settles is lag, not a miss.
  // Only edits say where the lyrics belong; a watched song just echoes the correction it was shown.
  const close = samples.filter(
    (sample) => sample.edited && Math.abs(sample.finalMs - sample.bestMs!) <= MATCH_TOLERANCE_MS * 2,
  );
  const bias = close.length >= MIN_BIAS_SAMPLES
    ? Math.max(-MAX_BIAS_MS, Math.min(MAX_BIAS_MS, Math.round(median(close.map((sample) => sample.finalMs - sample.bestMs!)) / 10) * 10))
    : 0;
  if (samples.length < MIN_SAMPLES) return { ...defaultTuning, biasMs: bias };
  let best = defaultTuning;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const minProminence of prominenceSteps) {
    for (const minMargin of marginSteps) {
      let cost =
        PRIOR_WEIGHT *
        (Math.abs(minProminence - defaultTuning.minProminence) / 0.5 +
          Math.abs(minMargin - defaultTuning.minMargin) / 0.5);
      for (const sample of samples) {
        const weight = sample.edited ? EDIT_WEIGHT : WATCH_WEIGHT;
        const right = Math.abs(sample.bestMs! + bias - sample.finalMs) <= MATCH_TOLERANCE_MS;
        // Where the original timing was already right, rejecting costs nothing either way.
        const needed = Math.abs(sample.finalMs) >= MIN_CORRECTION_MS;
        if (accepts(sample, minProminence, minMargin)) {
          if (!right) cost += FALSE_ACCEPT_COST * weight;
        } else if (right && needed) {
          cost += MISSED_COST * weight;
        }
      }
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = { minProminence, minMargin, biasMs: bias };
      }
    }
  }
  return best;
}

export function autoSyncTuning(): AutoSyncTuning {
  cachedTuning ??= fitTuning(Object.values(readSamples()));
  return cachedTuning;
}

/** The correction at the best match, trusted or not, or null when nothing could be scored. */
export function bestCorrection(evidence: OffsetEvidence): number | null {
  return evidence.bestMs === null ? null : evidence.bestMs + autoSyncTuning().biasMs;
}

/** The correction to apply for this evidence under the current tuning, or null when it is not trusted. */
export function trustedCorrection(evidence: OffsetEvidence): number | null {
  const tuning = autoSyncTuning();
  if (!accepts(evidence, tuning.minProminence, tuning.minMargin)) return null;
  const correctionMs = bestCorrection(evidence)!;
  return Math.abs(correctionMs) < MIN_CORRECTION_MS ? 0 : correctionMs;
}
