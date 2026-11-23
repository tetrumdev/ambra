import { useEffect, useSyncExternalStore } from "react";
import { coreSettingsProfile, subscribeCore } from "../api/core";
import { useAudioSettings } from "./AudioSettingsContext";
import { loadAudioSettings } from "../utils/audioSettings";
import { getPersistentItem, setPersistentItem } from "../utils/persistentStorage";
import { preferencesKey, withSyncedSettings, type AppPreferences } from "../utils/preferences";

const PROFILE_KEY = "ambra.settings-profile";
const AUDIO_KEY = "ambra.audio-settings.v1";
const stashKey = (key: string, profile: string) => `${key}@${profile}`;

/**
 * Each session carries its own settings on this device, or shares another session's (the
 * server names whose: the profile). Following a session with another profile sets the current
 * settings aside under the old one and brings back the new one's; a profile this device hasn't
 * used yet starts from the settings as they are.
 */
export function useSettingsProfile(setPreferences: (change: (current: AppPreferences) => AppPreferences) => void) {
  const profile = useSyncExternalStore(subscribeCore, coreSettingsProfile);
  const audio = useAudioSettings();
  const audioReady = audio !== null && !audio.loading;
  useEffect(() => {
    if (!profile || !audio || !audioReady) return;
    let previous: string | null;
    try {
      previous = localStorage.getItem(PROFILE_KEY);
      localStorage.setItem(PROFILE_KEY, profile);
    } catch { return; /* Storage unavailable: nothing to set aside or bring back. */ }
    if (!previous || previous === profile) return;

    // The latest preferences reach storage first, so the ones set aside are current.
    window.dispatchEvent(new Event("ambra:save-session"));
    const preferences = getPersistentItem(preferencesKey);
    if (preferences !== null) setPersistentItem(stashKey(preferencesKey, previous), preferences);
    const restored = getPersistentItem(stashKey(preferencesKey, profile));
    if (restored !== null) {
      setPersistentItem(preferencesKey, restored);
      setPreferences(withSyncedSettings);
    }

    void audio.update(current => {
      setPersistentItem(stashKey(AUDIO_KEY, previous), JSON.stringify(current));
      const key = stashKey(AUDIO_KEY, profile);
      return getPersistentItem(key) === null ? current : loadAudioSettings(key);
    });
  }, [profile, audioReady]);
}
