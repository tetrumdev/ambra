import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Track } from "../src/types/music";

const calls: { command: string; args?: Record<string, unknown> }[] = [];
const listeners = new Map<string, (event: { payload: unknown }) => void>();
let status = { currentSource: "/first.flac", currentTime: 30, duration: 180, isPlaying: true, buffering: false, ended: false, error: null, audioQuality: null };
let nextRead: Promise<typeof status> | null = null;
const core = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...core, isTauri: () => true,
  invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "native_audio_status") {
      const read = nextRead;
      nextRead = null;
      return read ?? { ...status };
    }
    if (command === "play_native_audio") status.isPlaying = true;
    if (command === "pause_native_audio") status.isPlaying = false;
    return null;
  },
}));
const events = await import("@tauri-apps/api/event");
mock.module("@tauri-apps/api/event", () => ({
  ...events,
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => { if (listeners.get(name) === handler) listeners.delete(name); };
  },
}));
let webviewFocuses = 0;
let pendingViewFocus: Promise<void> | null = null;
const webview = await import("@tauri-apps/api/webview");
mock.module("@tauri-apps/api/webview", () => ({
  ...webview,
  getCurrentWebview: () => ({ setFocus: async () => { webviewFocuses++; await pendingViewFocus; } }),
}));
const { useAudioPlayer } = await import("../src/hooks/useAudioPlayer");
const { PlaybackProgress } = await import("../src/components/PlaybackProgress");
const dom = new Window({ url: "http://localhost/" });
const tracks = ["first", "second", "third"].map(name => ({
  globalId: `local:/${name}.flac`, provider: "local", providerTrackId: `/${name}.flac`,
  audio: `asset://localhost/${name}.flac`, name, artist: "Artist", album: "Album", durationSeconds: 180,
  cover: "", nativeCover: null, playbackKind: "file",
} as Track));
let index = 0;
let player: ReturnType<typeof useAudioPlayer>;
function Harness() {
  player = useAudioPlayer(tracks, { trackId: tracks[0].globalId, positionSeconds: 30 }, {
    next: () => tracks[++index], previous: () => tracks[--index],
    peekNext: () => tracks[index + 1], completeCurrent: () => tracks[++index], nextTrack: tracks[index + 1],
  }, () => {});
  return <div><span data-track>{player.currentTrack?.name}</span><PlaybackProgress clock={player.clock} duration={player.duration} onSeek={player.seek} /></div>;
}
beforeAll(() => {
  Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
});
afterAll(() => { dom.happyDOM.abort(); });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("returning to the window replaces a stalled status read and reconciles a missed gapless handoff", async () => {
  index = 0;
  const container = document.createElement("div");
  const root = createRoot(container);
  let finishOldRead!: (value: typeof status) => void;
  nextRead = new Promise(resolve => { finishOldRead = resolve; });
  const old = { ...status };
  try {
    await act(async () => { root.render(<Harness />); await wait(250); });
    // Let the restored load settle and its first status read stall.
    await act(async () => { await wait(250); });
    expect(nextRead).toBeNull();
    const loadsBefore = calls.filter(call => call.command === "load_native_audio").length;
    status = { ...status, currentSource: "/second.flac", currentTime: 48 };
    await act(async () => { window.dispatchEvent(new dom.Event("focus")); });
    expect(container.querySelector("[data-track]")?.textContent).toBe("second");
    expect(player.clock.get()).toBe(48);
    expect(calls.filter(call => call.command === "load_native_audio")).toHaveLength(loadsBefore);
    await act(async () => { finishOldRead(old); });
    expect(player.currentTrack?.name).toBe("second");
    expect(player.clock.get()).toBe(48);

    status.currentTime = 81;
    await act(async () => { document.dispatchEvent(new dom.Event("visibilitychange")); });
    expect(player.clock.get()).toBe(81);
    expect(calls.some(call => call.command === "set_native_media_metadata" && (call.args?.metadata as { title: string })?.title === "second")).toBe(true);
    expect(calls.some(call => call.command === "set_native_media_commands_enabled" && call.args?.enabled === true)).toBe(true);

    await act(async () => { listeners.get("native-media-control")?.({ payload: "pause" }); });
    expect(status.isPlaying).toBe(false);
    await act(async () => { listeners.get("native-media-control")?.({ payload: "play" }); });
    expect(status.isPlaying).toBe(true);
    await act(async () => { listeners.get("native-media-control")?.({ payload: "next" }); });
    expect(player.currentTrack?.name).toBe("third");
  } finally {
    await act(async () => root.unmount());
  }
  expect(listeners.has("native-media-control")).toBe(false);
});

test("a stalled status read recovers without a focus event", async () => {
  index = 0;
  status = { ...status, currentSource: "/first.flac", currentTime: 30 };
  nextRead = new Promise(() => {});
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await wait(250); });
    expect(nextRead).toBeNull();
    status.currentTime = 55;
    await act(async () => { await wait(2100); });
    expect(player.clock.get()).toBe(55);
  } finally {
    await act(async () => root.unmount());
  }
});

test("native window activation commits the audible track and three-minute position without a webpage focus event or Pause", async () => {
  index = 0;
  status = { ...status, currentSource: "/first.flac", currentTime: 30, duration: 240, isPlaying: true };
  let finishOldRead!: (value: typeof status) => void;
  nextRead = new Promise(resolve => { finishOldRead = resolve; });
  const old = { ...status };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await wait(250); });
    expect(nextRead).toBeNull();
    expect(container.querySelector("[data-track]")?.textContent).toBe("first");
    expect(container.querySelector("#currentTime")?.textContent).toBe("0:30");
    const started = calls.length;
    const focusedBefore = webviewFocuses;
    status = { ...status, currentSource: "/second.flac", currentTime: 187 };
    pendingViewFocus = new Promise(() => {});
    await act(async () => {
      // The background source event can arrive while React still displays the
      // outgoing song. Its native ref and queue already describe the next one.
      listeners.get("native-audio-source-changed")!({ payload: "/second.flac" });
      await wait(0);
      const activate = listeners.get("tauri://focus");
      expect(activate).toBeDefined();
      await activate!({ payload: null });
      // Check the DOM before act flushes pending React work: returning to the
      // native window must commit this snapshot without a click or key press.
      expect(container.querySelector("[data-track]")?.textContent).toBe("second");
      expect(container.querySelector("#currentTime")?.textContent).toBe("3:07");
    });
    expect(webviewFocuses).toBe(focusedBefore + 1);
    expect(calls.slice(started).filter(call => ["load_native_audio", "play_native_audio", "pause_native_audio"].includes(call.command))).toEqual([]);
    await act(async () => { finishOldRead(old); });
    expect(container.querySelector("#currentTime")?.textContent).toBe("3:07");
    expect(player.isPlaying).toBe(true);
  } finally {
    pendingViewFocus = null;
    await act(async () => root.unmount());
  }
  expect(listeners.has("tauri://focus")).toBe(false);
});
