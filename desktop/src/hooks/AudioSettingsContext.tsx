import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { defaultAudioSettings, loadAudioSettings, saveAudioSettings, type AudioSettings, type NativeAudioDevice } from "../utils/audioSettings";

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
  const refresh = useCallback((): Promise<void> => {
    const operation = chain.current.then(async () => {
      try {
        const [loaded, connected] = await Promise.all([api.load(), api.devices()]);
        latest.current = loaded; setSettings(loaded); setDevices(connected); setError(null);
      } catch (error) { setError(String(error)); }
      finally { setLoading(false); }
    });
    chain.current = operation;
    return operation;
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const update = useCallback((change: (current: AudioSettings) => AudioSettings): Promise<boolean> => {
    const operation = chain.current.then(async () => {
      setSaving(true);
      try {
        const next = change(latest.current);
        await api.save(next);
        latest.current = next; setSettings(next); setError(null);
        return true;
      } catch (error) { setError(String(error)); return false; }
      finally { setSaving(false); }
    });
    chain.current = operation;
    return operation;
  }, [api]);
  return <AudioSettingsContext.Provider value={{ settings, devices, native: api.native, loading, saving, error, update, refresh }}>{children}</AudioSettingsContext.Provider>;
}
