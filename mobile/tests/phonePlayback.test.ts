import { expect, test } from "bun:test";
import { PhonePlayback, type PhonePlayer } from "../src/phonePlayback";

type Listener = (status: Record<string, unknown>) => void;
function fakePlayer(created: { source: string; player: PhonePlayer; emit: Listener }[]) {
  return (source: string) => {
    const listeners: Listener[] = [];
    const player = {
      playing: false, isLoaded: true, volume: 1, currentTime: 0, duration: 200,
      play() { player.playing = true; }, pause() { player.playing = false; },
      async seekTo() {}, remove() {}, setActiveForLockScreen() {}, updateLockScreenMetadata() {},
      addListener(event: string, callback: Listener) { if (event === "playbackStatusUpdate") listeners.push(callback); return { remove() {} }; },
    } as unknown as PhonePlayer & { playing: boolean };
    created.push({ source, player, emit: status => listeners.forEach(listener => listener(status)) });
    return player;
  };
}

function host(created: { source: string; player: PhonePlayer; emit: Listener }[], prefetched: string[]) {
  return {
    create: fakePlayer(created), activate: async () => {}, mediaUrl: (source: string) => `bridge${source}`,
    prefetch: (source: string) => { prefetched.push(source); },
    metadata: () => ({ title: "Song" }), ownsOutput: () => true, transport: () => {}, changed: () => {},
  };
}

test("the queued song is downloaded early and plays by itself when the current one ends", async () => {
  const created: { source: string; player: PhonePlayer; emit: Listener }[] = [];
  const prefetched: string[] = [];
  const playback = new PhonePlayback(host(created, prefetched));
  await playback.execute("load_native_audio", { source: "/api/a", nextSource: "/api/b", positionSeconds: 0, autoplay: true });
  expect(prefetched).toEqual(["/api/b"]);
  created[0].emit({ isLoaded: true, playing: false, isBuffering: false, currentTime: 200, didJustFinish: true });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(created.map(entry => entry.source)).toEqual(["bridge/api/a", "bridge/api/b"]);
  expect(playback.status().currentSource).toBe("/api/b");
  expect(playback.status().ended).toBe(false);
});

test("without a queued song the end is reported, and a later queue command is prefetched", async () => {
  const created: { source: string; player: PhonePlayer; emit: Listener }[] = [];
  const prefetched: string[] = [];
  const playback = new PhonePlayback(host(created, prefetched));
  await playback.execute("load_native_audio", { source: "/api/a", positionSeconds: 0, autoplay: true });
  await playback.execute("warm_native_audio", { source: "/api/c" });
  created[0].emit({ isLoaded: true, playing: false, isBuffering: false, currentTime: 200, didJustFinish: true });
  expect(playback.status().ended).toBe(true);
  expect(created).toHaveLength(1);
  await playback.execute("queue_native_audio", { source: "/api/d", expectedSource: "/api/a" });
  expect(prefetched).toEqual(["/api/c", "/api/d"]);
});

test("a skip pauses the old song until the core loads the next one", async () => {
  const created: { source: string; player: PhonePlayer; emit: Listener }[] = [];
  const playback = new PhonePlayback(host(created, []));
  await playback.execute("load_native_audio", { source: "/api/a", positionSeconds: 0, autoplay: true });
  const old = created[0].player;
  expect(old.playing).toBe(true);
  expect(playback.holdForSkip()).toBe(true);
  expect(old.playing).toBe(false);
  // Reported as still playing, waiting on the next song, not as the listener's own pause.
  created[0].emit({ isLoaded: true, playing: false, isBuffering: false, currentTime: 10 });
  expect(playback.status()).toMatchObject({ isPlaying: false, buffering: true });
  expect(playback.status().control).toBeUndefined();
  await playback.execute("load_native_audio", { source: "/api/b", positionSeconds: 0, autoplay: true });
  expect(created[1].player.playing).toBe(true);
  created[1].emit({ isLoaded: true, playing: true, isBuffering: false, currentTime: 0 });
  expect(playback.status().buffering).toBe(false);
});

test("a previous that restarts the song plays on after the core's seek", async () => {
  const created: { source: string; player: PhonePlayer; emit: Listener }[] = [];
  const playback = new PhonePlayback(host(created, []));
  await playback.execute("load_native_audio", { source: "/api/a", positionSeconds: 0, autoplay: true });
  playback.holdForSkip();
  expect(created[0].player.playing).toBe(false);
  await playback.execute("seek_native_audio", { positionSeconds: 0 });
  expect(created[0].player.playing).toBe(true);
  created[0].emit({ isLoaded: true, playing: true, isBuffering: false, currentTime: 0 });
  expect(playback.status().buffering).toBe(false);
});

test("a skip with nothing to skip to resumes, and a lost one becomes a pause", async () => {
  const created: { source: string; player: PhonePlayer; emit: Listener }[] = [];
  const playback = new PhonePlayback(host(created, []));
  await playback.execute("load_native_audio", { source: "/api/a", positionSeconds: 0, autoplay: true });
  playback.holdForSkip();
  playback.endSkip(true);
  expect(created[0].player.playing).toBe(true);
  playback.holdForSkip();
  playback.endSkip(false);
  expect(created[0].player.playing).toBe(false);
  created[0].emit({ isLoaded: true, playing: false, isBuffering: false, currentTime: 0 });
  expect(playback.status()).toMatchObject({ buffering: false, control: { seq: 1, playing: false } });
});
