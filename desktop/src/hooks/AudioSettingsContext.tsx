import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { defaultAudioSettings, loadAudioSettings, saveAudioSettings, validatePreset, type AudioSettings, type DspPreset, type NativeAudioDevice, type NormalizationMode } from "../utils/audioSettings";
import { getPersistentItem, setPersistentItem } from "../utils/persistentStorage";
import { serverStateStatus, subscribeRemoteChanges } from "../utils/serverState";
import { serverConnection } from "../api/serverConnection";

/**
 * DSP presets and volume normalization follow the listener to every device using the server;
 * each device's outputs, and which preset each uses, stay its own. Convolution files are
 * fetched from the server before a preset that needs them is applied.
 */
const SHARED_KEY = "ambra.dsp-presets.v1";
type SharedDsp = { version: 1; presets: DspPreset[]; normalization: NormalizationMode; normalizationTargetLufs: number };

function sharedPart(settings: AudioSettings): SharedDsp {
  return { version: 1, presets: settings.presets, normalization: settings.normalization, normalizationTargetLufs: settings.normalizationTargetLufs };
}

function parseShared(raw: string | null): SharedDsp | null {
  try {
    const value = JSON.parse(raw ?? "null") as SharedDsp | null;
    if (value?.version !== 1 || !Array.isArray(value.presets) || !["off", "track", "album"].includes(value.normalization)
      || !Number.isFinite(value.normalizationTargetLufs)) return null;
    const ids = new Set<string>();
    for (const preset of value.presets) {
      validatePreset(preset);
      if (typeof preset.id !== "string" || ids.has(preset.id) || !Array.isArray(preset.convolution)) return null;
      ids.add(preset.id);
    }
    return value;
  } catch { return null; }
}

const impulseIds = (presets: DspPreset[]) => [...new Set(presets.flatMap(preset => preset.convolution.map(impulse => impulse.id)))];
const syncing = () => isTauri() && serverStateStatus().ready;

/** `local` with the shared presets, fetching their convolution files; a file nobody has is left out. */
async function withShared(local: AudioSettings, shared: SharedDsp): Promise<{ settings: AudioSettings; missing: string[] }> {
  const missing = new Set(await invoke<string[]>("sync_dsp_impulses", { ids: impulseIds(shared.presets) }).catch(() => impulseIds(shared.presets)));
  const presets = shared.presets.map(preset => ({ ...preset, convolution: preset.convolution.filter(impulse => !missing.has(impulse.id)) }));
  const ids = new Set(presets.map(preset => preset.id));
  return {
    settings: {
      ...local, presets, normalization: shared.normalization, normalizationTargetLufs: shared.normalizationTargetLufs,
      outputs: local.outputs.map(output => output.presetId && !ids.has(output.presetId) ? { ...output, presetId: null } : output),
    },
    missing: [...missing],
  };
}

function publishShared(settings: AudioSettings) {
  const shared = JSON.stringify(sharedPart(settings));
  if (getPersistentItem(SHARED_KEY) === shared) return;
  setPersistentItem(SHARED_KEY, shared);
  void invoke("sync_dsp_impulses", { ids: impulseIds(settings.presets) }).catch(() => {});
}

export type AudioSettingsApi = {
  native: boolean;
  load: () => Promise<AudioSettings>;
  devices: () => Promise<NativeAudioDevice[]>;
  save: (settings: AudioSettings) => Promise<void>;
};
const desktopApi: AudioSettingsApi = {
  native: isTauri(),
  load: () => isTauri() ? invoke("native_audio_settings") : Promise.resolve(loadAudioSettings()),
  devices: () => isTauri() ? invoke("list_native_audio_devices") : Promise.resolve([]),
  save: async settings => { if (isTauri()) await invoke("set_native_audio_settings", { settings }); else saveAudioSettings(settings); },
};
type AudioSettingsStore = {
  settings: AudioSettings; devices: NativeAudioDevice[]; native: boolean; loading: boolean; saving: boolean; error: string | null;
  update: (change: (current: AudioSettings) => AudioSettings) => Promise<boolean>;
  refresh: () => Promise<void>;
};
const AudioSettingsContext = createContext<AudioSettingsStore | null>(null);
export const useAudioSettings = () => useContext(AudioSettingsContext);

export function AudioSettingsProvider({ children, api = desktopApi }: { children: ReactNode; api?: AudioSettingsApi }) {
  const [settings, setSettings] = useState(defaultAudioSettings);
  const latest = useRef(settings);
  const [devices, setDevices] = useState<NativeAudioDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  /** Applies the shared presets to `loaded`, or shares this device's when the server has none yet. */
  const adoptShared = useCallback(async (loaded: AudioSettings) => {
    if (!syncing() || api !== desktopApi) return loaded;
    let shared = parseShared(getPersistentItem(SHARED_KEY));
    if (!shared) {
      if (serverConnection?.mode === "join" && !serverConnection.fallback) {
        shared = sharedPart(defaultAudioSettings());
      } else {
        publishShared(loaded);
        return loaded;
      }
    }
    if (JSON.stringify(sharedPart(loaded)) === JSON.stringify(shared)) return loaded;
    const { settings: merged, missing } = await withShared(loaded, shared);
    await api.save(merged);
    if (missing.length) setError("Some convolution files used by your presets aren't on the server yet, so they're off on this computer.");
    return merged;
  }, [api]);
  const refresh = useCallback((): Promise<void> => {
    const operation = chain.current.then(async () => {
      try {
        const [loaded, connected] = await Promise.all([api.load(), api.devices()]);
        const adopted = await adoptShared(loaded);
        latest.current = adopted; setSettings(adopted); setDevices(connected); setError(null);
      } catch (error) { setError(String(error)); }
      finally { setLoading(false); }
    });
    chain.current = operation;
    return operation;
  }, [api, adoptShared]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Presets edited on another device apply here as soon as they're saved.
  useEffect(() => subscribeRemoteChanges(keys => {
    if (!keys.has(SHARED_KEY)) return;
    chain.current = chain.current.then(async () => {
      try {
        const adopted = await adoptShared(latest.current);
        latest.current = adopted; setSettings(adopted);
      } catch (error) { setError(String(error)); }
    });
  }), [adoptShared]);
  const update = useCallback((change: (current: AudioSettings) => AudioSettings): Promise<boolean> => {
    const operation = chain.current.then(async () => {
      setSaving(true);
      try {
        const next = change(latest.current);
        await api.save(next);
        latest.current = next; setSettings(next); setError(null);
        if (syncing() && api === desktopApi) publishShared(next);
        return true;
      } catch (error) { setError(String(error)); return false; }
      finally { setSaving(false); }
    });
    chain.current = operation;
    return operation;
  }, [api]);
  return <AudioSettingsContext.Provider value={{ settings, devices, native: api.native, loading, saving, error, update, refresh }}>{children}</AudioSettingsContext.Provider>;
}
