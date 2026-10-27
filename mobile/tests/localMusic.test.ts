import { afterAll, expect, test } from "bun:test";
import type { AudioEvents, AudioStatus } from "expo-audio";
import { emptyLocalLibrary, LocalMusic, parseLocalLibrary, type LocalLibrary } from "../src/localLibrary";
import type { PhonePlayer } from "../src/phonePlayback";

const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (async () => { requests++; throw new Error("No server and no Internet"); }) as unknown as typeof fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
class Audio implements PhonePlayer {
  playing = false; isLoaded = true; volume = 1; currentTime = 0; duration = 200; removed = false;
  listener: ((status: AudioStatus) => void) | null = null;
  remote: AudioEvents["remoteCommand"] | null = null;
  constructor(readonly source: string) {}
  emit(extra: Partial<AudioStatus> = {}) { this.listener?.({ playing: this.playing, currentTime: this.currentTime, duration: this.duration, isLoaded: true, isBuffering: false, error: null, didJustFinish: false, ...extra } as AudioStatus); }
  addListener<Event extends "playbackStatusUpdate" | "remoteCommand">(event: Event, callback: AudioEvents[Event]) {
    if (event === "remoteCommand") { this.remote = callback as AudioEvents["remoteCommand"]; return { remove: () => { this.remote = null; } }; }
    this.listener = callback as (status: AudioStatus) => void; this.emit(); return { remove: () => { this.listener = null; } };
  }
  play() { this.playing = true; this.emit(); }
  pause() { this.playing = false; this.emit(); }
  async seekTo(position: number) { this.currentTime = position; this.emit(); }
  remove() { this.removed = true; }
  setActiveForLockScreen() {}
  updateLockScreenMetadata() {}
}
const initial = (): LocalLibrary => ({ ...emptyLocalLibrary(), tracks: ["a", "b"].map(id => ({ id, uri: `file:///documents/${id}.mp3`, name: id, artist: "Artist", album: "Album", durationSeconds: 200 })) });
function harness(state = initial()) {
  const players: Audio[] = []; let saved = state;
  const music = new LocalMusic(state, {
    create: source => { const player = new Audio(source); players.push(player); return player; }, activate: async () => {},
    save: async value => { saved = parseLocalLibrary(JSON.stringify(value)); },
  });
  return { music, players, saved: () => saved };
}
test("local files play, seek, skip and save playlists, history, volume and queue without a server", async () => {
  const h = harness();
  await h.music.edit(state => ({ ...state, playlists: [{ id: "local", name: "My music", trackIds: ["b", "a"] }] }));
  await h.music.play("b", ["b", "a"]);
  expect(h.players[0].source).toBe("file:///documents/b.mp3");
  expect(h.players[0].playing).toBe(true);
  await h.music.command("seek", { positionSeconds: 42 });
  await h.music.command("volume", { volume: 60 });
  expect(h.players[0].currentTime).toBe(42);
  expect(h.players[0].volume).toBe(0.6);
  expect(h.saved().history.at(-1)?.trackId).toBe("b");
  await h.music.release();
  const restored = harness(h.saved());
  expect(restored.players).toHaveLength(0);
  expect(restored.music.snapshot().library.playlists[0].name).toBe("My music");
  expect(restored.music.snapshot().library.positionSeconds).toBe(42);
  await restored.music.command("toggle");
  expect(restored.players[0].source).toBe("file:///documents/b.mp3");
  expect(restored.players[0].currentTime).toBe(42);
  expect(restored.players[0].volume).toBe(0.6);
  await restored.music.command("next");
  expect(restored.players.at(-1)?.source).toBe("file:///documents/a.mp3");
  await restored.music.command("previous");
  expect(restored.players.at(-1)?.source).toBe("file:///documents/b.mp3");
  await restored.music.release();
  expect(requests).toBe(0);
});
test("native end and headset skips advance only the local queue; released players cannot control another mode", async () => {
  const h = harness(); await h.music.play("a");
  h.players[0].emit({ didJustFinish: true, playing: false });
  await h.music.command("pause");
  expect(h.music.track()?.id).toBe("b");
  const remote = h.players.at(-1)!.remote!;
  remote({ action: "previous" });
  await h.music.command("pause");
  expect(h.music.track()?.id).toBe("a");
  await h.music.release();
  remote({ action: "next" });
  await h.music.command("pause");
  expect(h.music.track()?.id).toBe("a");
  expect(h.players.every(player => player.removed)).toBe(true);
});
test("corrupt state and remote streams cannot masquerade as device files", () => {
  expect(() => parseLocalLibrary('{"version":9}')).toThrow();
  const state = initial(); state.tracks[0].uri = "http://server/api/stream";
  expect(() => parseLocalLibrary(JSON.stringify(state))).toThrow("Invalid local track");
  const dangling = initial(); dangling.playlists = [{ id: "broken", name: "Broken", trackIds: ["missing"] }];
  expect(() => parseLocalLibrary(JSON.stringify(dangling))).toThrow("Invalid local playlist");
});
test("removing a local song repairs queue and playlists before removing its file", async () => {
  const h = harness();
  await h.music.edit(state => ({ ...state, playlists: [{ id: "p", name: "Local", trackIds: ["a", "b"] }] }));
  await h.music.play("a");
  await h.music.removeTrack("a");
  expect(h.music.track()?.id).toBe("b");
  expect(h.saved().playlists[0].trackIds).toEqual(["b"]);
  expect(h.saved().tracks.map(track => track.id)).toEqual(["b"]);
  expect(h.saved().history).toEqual([]);
  expect(h.music.snapshot().playing).toBe(false);
  await h.music.release();
});
