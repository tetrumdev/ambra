import { setAudioModeAsync } from "expo-audio";

let phoneAudio = false;
let changes: Promise<unknown> = Promise.resolve();
export const phoneAudioActive = () => phoneAudio;

/** One owner for the app-wide audio session, shared with the remote Live Activity lease. */
export function configureAudioSession(local = phoneAudio): Promise<void> {
  phoneAudio = local;
  const applied = changes.catch(() => {}).then(() => setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: phoneAudio ? "doNotMix" : "mixWithOthers",
    allowsRecording: false,
  }));
  changes = applied;
  return applied;
}
