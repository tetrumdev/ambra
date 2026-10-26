import { setAudioModeAsync } from "expo-audio";

let changes: Promise<unknown> = Promise.resolve();

/** Serialize audio-session changes when the phone gains or releases playback. */
export function configureAudioSession(local: boolean): Promise<void> {
  const applied = changes.catch(() => {}).then(() => setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: local ? "doNotMix" : "mixWithOthers",
    allowsRecording: false,
  }));
  changes = applied;
  return applied;
}
