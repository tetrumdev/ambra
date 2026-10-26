import { expect, mock, test } from "bun:test";

const modes: { interruptionMode?: string; shouldPlayInBackground?: boolean }[] = [];
mock.module("../../mobile/node_modules/expo-audio", () => ({
  setAudioModeAsync: async (mode: typeof modes[number]) => { modes.push(mode); },
}));
const { configureAudioSession } = await import("../../mobile/src/audioSession");

test("queued audio-session changes preserve each owner and always enable background playback", async () => {
  const remote = configureAudioSession(false);
  const local = configureAudioSession(true);
  await Promise.all([remote, local]);
  expect(modes.map(mode => mode.interruptionMode)).toEqual(["mixWithOthers", "doNotMix"]);
  expect(modes.every(mode => mode.shouldPlayInBackground)).toBe(true);
  await configureAudioSession(false);
  expect(modes.map(mode => mode.interruptionMode)).toEqual(["mixWithOthers", "doNotMix", "mixWithOthers"]);
});
