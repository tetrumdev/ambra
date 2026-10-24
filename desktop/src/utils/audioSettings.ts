import { getPersistentItem, setPersistentItem } from "./persistentStorage";

export type EqBand = { enabled: boolean; kind: "peak" | "lowShelf" | "highShelf"; frequency: number; gainDb: number; q: number };
export type ImpulseFile = { id: string; name: string; sampleRate: number; channels: number; frames: number };
export type DspPreset = { id: string; name: string; enabled: boolean; headroomDb: number; bands: EqBand[]; convolution: ImpulseFile[] };
export type OutputSettings = { id: string; name: string; enabled: boolean; exclusiveMode: boolean; resyncDelayMs: number; presetId: string | null; volume: number };
/** One constant gain per song or album; never compression or limiting. */
export type NormalizationMode = "off" | "track" | "album";
export type AudioSettings = { version: 1; selectedOutputId: string; outputs: OutputSettings[]; presets: DspPreset[]; normalization: NormalizationMode; normalizationTargetLufs: number };
export type NativeAudioDevice = { id: string; name: string; isDefault: boolean };
export type DspStatus = { presetName: string | null; active: boolean; sampleRate: number | null; peakDbfs: number | null; clippedSamples: number; warnings: string[] };

/** ReplayGain's reference loudness, and the range a listener may move the target within (matches the engine). */
export const REFERENCE_LUFS = -18;
export const MIN_TARGET_LUFS = -30;
export const MAX_TARGET_LUFS = -6;

export const defaultAudioSettings = (): AudioSettings => ({ version: 1, selectedOutputId: "", presets: [], normalization: "off", normalizationTargetLufs: REFERENCE_LUFS, outputs: [
  { id: "", name: "System Default", enabled: true, exclusiveMode: false, resyncDelayMs: 0, presetId: null, volume: 100 },
] });
const storageKey = "ambra.audio-settings.v1";
export function loadAudioSettings(): AudioSettings {
  try {
    const value = JSON.parse(getPersistentItem(storageKey) ?? "null") as AudioSettings | null;
    if (value?.version === 1 && typeof value.selectedOutputId === "string"
      && Array.isArray(value.outputs) && value.outputs.length <= 256
      && Array.isArray(value.presets) && value.presets.length <= 64) {
      const presets = new Set<string>();
      for (const preset of value.presets) {
        foldOutputGain(preset);
        validatePreset(preset);
        if (typeof preset.id !== "string" || !preset.id || presets.has(preset.id)
          || typeof preset.enabled !== "boolean" || !Array.isArray(preset.convolution)
          || preset.convolution.some(i => !i || typeof i.id !== "string" || typeof i.name !== "string"
            || !Number.isInteger(i.sampleRate) || !Number.isInteger(i.frames) || ![1, 2].includes(i.channels))) throw new Error("Invalid preset");
        presets.add(preset.id);
      }
      const outputs = new Set<string>();
      for (const output of value.outputs) {
        // Existing device settings predate resync delay; don't discard their DSP.
        if (output && output.resyncDelayMs === undefined) output.resyncDelayMs = 0;
        if (output && output.volume === undefined) output.volume = 100;
        if (!output || typeof output.id !== "string" || outputs.has(output.id)
          || typeof output.name !== "string" || !output.name.trim()
          || typeof output.enabled !== "boolean" || typeof output.exclusiveMode !== "boolean"
          || !Number.isInteger(output.resyncDelayMs) || output.resyncDelayMs < 0 || output.resyncDelayMs > 10000
          || !Number.isFinite(output.volume) || output.volume < 0 || output.volume > 100
          || (output.presetId !== null && !presets.has(output.presetId))) throw new Error("Invalid output");
        outputs.add(output.id);
      }
      // Settings saved before normalization existed leave it off.
      if (!["off", "track", "album"].includes(value.normalization)) value.normalization = "off";
      if (!Number.isFinite(value.normalizationTargetLufs) || value.normalizationTargetLufs < MIN_TARGET_LUFS
        || value.normalizationTargetLufs > MAX_TARGET_LUFS) value.normalizationTargetLufs = REFERENCE_LUFS;
      if (outputs.has("") && outputs.has(value.selectedOutputId)) return value;
    }
  } catch { /* A corrupt working copy must not prevent startup. */ }
  return defaultAudioSettings();
}
/** Presets once had an output gain after the EQ, which only ever undid headroom; it becomes less headroom. */
function foldOutputGain(preset: DspPreset & { outputGainDb?: number }) {
  if (preset.outputGainDb === undefined) return;
  if (Number.isFinite(preset.outputGainDb)) preset.headroomDb = Math.min(30, Math.max(0, preset.headroomDb - preset.outputGainDb));
  delete preset.outputGainDb;
}
export function saveAudioSettings(settings: AudioSettings) { setPersistentItem(storageKey, JSON.stringify(settings)); }
export function visibleOutputs(settings: AudioSettings, devices: NativeAudioDevice[]) {
  const available = new Set(["", ...devices.map(device => device.id)]);
  return settings.outputs.filter(output => output.enabled && available.has(output.id));
}
export function newPreset(name = "New preset"): DspPreset {
  return { id: crypto.randomUUID(), name, enabled: true, headroomDb: 0, bands: [], convolution: [] };
}
export function validatePreset(preset: DspPreset) {
  if (typeof preset.name !== "string" || !preset.name.trim() || preset.name.length > 120) throw new Error("Give this preset a name of at most 120 characters.");
  if (!Number.isFinite(preset.headroomDb) || preset.headroomDb < 0 || preset.headroomDb > 30)
    throw new Error("Headroom must be between 0 and 30 dB.");
  if (!Array.isArray(preset.bands) || preset.bands.length > 32) throw new Error("Use at most 32 EQ bands.");
  for (const band of preset.bands) {
    if (!band || typeof band.enabled !== "boolean" || !["peak", "lowShelf", "highShelf"].includes(band.kind)
      || !Number.isFinite(band.frequency) || band.frequency < 10 || band.frequency > 96000
      || !Number.isFinite(band.gainDb) || band.gainDb < -24 || band.gainDb > 24
      || !Number.isFinite(band.q) || band.q < 0.1 || band.q > 20)
      throw new Error("EQ bands require 10–96000 Hz, -24–24 dB and Q 0.1–20.");
  }
}

// AutoEq / Equalizer APO parametric text, including disabled bands and Q shelves.
export function parseAutoEq(text: string): Pick<DspPreset, "headroomDb" | "bands"> {
  const bands: EqBand[] = [];
  let preamp = 0;
  const number = "([-+]?\\d+(?:\\.\\d+)?)";
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*Preamp:/i.test(line)) {
      const match = line.match(new RegExp(`Preamp:\\s*${number}\\s*dB`, "i"));
      if (!match) throw new Error("Invalid AutoEq preamp.");
      preamp = Number(match[1]);
    } else if (/^\s*Filter\s+\d+:/i.test(line)) {
      const match = line.match(new RegExp(`Filter\\s+\\d+:\\s*(ON|OFF)\\s+(PK|LSC?|HSC?)\\s+Fc\\s+${number}\\s*Hz\\s+Gain\\s+${number}\\s*dB\\s+Q\\s+${number}\\s*$`, "i"));
      if (!match) throw new Error("Import supports PK, LS/LSC and HS/HSC filters with frequency, gain and Q.");
      bands.push({ enabled: match[1].toUpperCase() === "ON", kind: match[2].toUpperCase() === "PK" ? "peak" : match[2].toUpperCase().startsWith("LS") ? "lowShelf" : "highShelf",
        frequency: Number(match[3]), gainDb: Number(match[4]), q: Number(match[5]) });
    }
  }
  if (!bands.length) throw new Error("No parametric EQ filters found in this file.");
  // A positive preamp would only push the EQ toward clipping, so it plays at unity instead.
  const result = { headroomDb: Math.min(30, Math.max(0, -preamp)), bands };
  validatePreset({ ...newPreset("Imported headphone EQ"), ...result });
  return result;
}
