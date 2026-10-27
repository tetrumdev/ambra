import { afterAll, expect, mock, test } from "bun:test";
import type { AudioStatus } from "expo-audio";

const players: TestPlayer[] = [];
class TestPlayer {
  playing = false; isLoaded = true; volume = 1; currentTime = 0; duration = 180; removed = false;
  metadata: { title?: string } | null = null;
  listeners = new Map<string, (status: AudioStatus) => void>();
  constructor(readonly source: string) { players.push(this); }
  addListener(event: string, callback: (status: AudioStatus) => void) { this.listeners.set(event, callback); return { remove: () => this.listeners.delete(event) }; }
  emit() { this.listeners.get("playbackStatusUpdate")?.({ playing: this.playing, isLoaded: true, currentTime: this.currentTime, duration: this.duration, isBuffering: false, didJustFinish: false } as AudioStatus); }
  play() { this.playing = true; this.emit(); }
  pause() { this.playing = false; this.emit(); }
  async seekTo(position: number) { this.currentTime = position; this.emit(); }
  setActiveForLockScreen(_active: boolean, metadata: { title?: string }) { this.metadata = metadata; }
  updateLockScreenMetadata(metadata: { title?: string }) { this.metadata = metadata; }
  remove() { this.removed = true; }
}
mock.module("../../mobile/node_modules/expo-audio", () => ({ createAudioPlayer: (source: string) => new TestPlayer(source), setAudioModeAsync: async () => {} }));
mock.module("../../mobile/node_modules/expo-constants", () => ({ default: { deviceName: "Test iPhone" } }));
mock.module("../../mobile/node_modules/react-native", () => ({ Platform: { OS: "ios" }, AppState: { addEventListener: () => ({ remove() {} }) } }));
mock.module("../../mobile/node_modules/expo-secure-store", () => ({
  getItemAsync: async (key: string) => ({ "ambra.server": "old-address", "ambra.token": "token", "ambra.client": "phone-test", "ambra.pairingPayload.v1": "ambra://pair/key" } as Record<string, string>)[key],
  setItemAsync: async () => {}, deleteItemAsync: async () => {},
}));
const baseUrl = `http://127.0.0.1:45000/${"a".repeat(64)}`;
mock.module("../../mobile/modules/ambra-network/src", () => ({ nativeNetworkAvailable: true, networkCall: async () => ({ baseUrl }) }));
const { command, refreshSession, restore } = await import("../../mobile/src/client");
const { followPhoneOutput, phoneEndpointInfo } = await import("../../mobile/src/phoneEndpoint");
const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

test("paired phone registers, accepts output selection, loads P2P audio, acknowledges commands, and releases when output moves", async () => {
  const track = { globalId: "current", name: "Current peer song", artist: "Artist", album: "Album", provider: "qobuz", cover: "", nativeCover: null, durationSeconds: 180 };
  const view = { instanceId: "server", revision: 1, queueRevision: 1, playing: true, buffering: false, positionSeconds: 30, duration: 180, output: null as unknown, outputOnline: true, error: null, queue: { current: { globalTrackId: track.globalId }, upcoming: [], tracks: [track] } };
  const results: { id: number; ok: boolean }[] = [];
  const reports: { name: string; status: { isPlaying: boolean } }[] = [];
  const jobs: { id: number; command: string; args: unknown }[] = [];
  let wake: (() => void) | undefined;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).slice(baseUrl.length).split("?")[0];
    if (path === "/api/session") return response(view);
    if (path === "/api/session/command") {
      const request = JSON.parse(String(init?.body));
      expect(request.action).toBe("output"); view.output = request.output; view.revision++;
      jobs.push({ id: 1, command: "select_native_audio_device", args: { deviceId: "system" } },
        { id: 2, command: "load_native_audio", args: { source: "/api/song.flac", positionSeconds: 30, autoplay: true } });
      wake?.(); return response(view);
    }
    if (path.endsWith("/presence")) { reports.push(JSON.parse(String(init?.body))); return response({}); }
    if (path.endsWith("/results")) { results.push(JSON.parse(String(init?.body))); return response({}); }
    if (path.endsWith("/commands")) {
      if (!jobs.length) await new Promise<void>((resolve, reject) => {
        const abort = () => { wake = undefined; reject(new Error("Aborted")); };
        init?.signal?.addEventListener("abort", abort, { once: true });
        wake = () => { init?.signal?.removeEventListener("abort", abort); wake = undefined; resolve(); };
      });
      return response(jobs.splice(0));
    }
    throw new Error(`Unexpected endpoint ${path}`);
  }) as typeof fetch;
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 1000;
    while (!condition()) { if (Date.now() > deadline) throw new Error("Phone output did not complete the protocol"); await new Promise(resolve => setTimeout(resolve, 1)); }
  };
  await restore();
  await refreshSession(new AbortController().signal);
  const stop = followPhoneOutput();
  try {
    await until(() => phoneEndpointInfo()?.ready === true);
    expect(reports[0].name).toBe("Test iPhone");
    await command("output", { output: { endpointId: "phone-test", deviceId: "system", endpointName: "Test iPhone", deviceName: "Test iPhone" } });
    await until(() => results.length === 2);
    expect(results).toEqual([{ id: 1, ok: true, value: null }, { id: 2, ok: true, value: null }]);
    expect(players[0].source).toBe(`${baseUrl}/api/song.flac`);
    expect(players[0].playing).toBe(true);
    expect(players[0].currentTime).toBe(30);
    expect(players[0].metadata?.title).toBe(track.name);
    view.output = { endpointId: "desktop", deviceId: "speakers" }; view.revision++;
    await refreshSession(new AbortController().signal);
    expect(players[0].removed).toBe(true);
  } finally { stop(); }
  expect(phoneEndpointInfo()).toBeNull();
});
