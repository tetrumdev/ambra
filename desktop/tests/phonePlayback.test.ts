import { describe, expect, test } from "bun:test";
import type { AudioStatus } from "../../mobile/node_modules/expo-audio";
import { PHONE_DEVICE_ID, PhonePlayback, type PhonePlayer } from "../../mobile/src/phonePlayback";

function harness() {
  const created: FakePlayer[] = [];
  const transport: { action: string; details?: Record<string, unknown> }[] = [];
  let owned = true;
  let activate = async () => {};
  let failLoad = false;
  class FakePlayer implements PhonePlayer {
    playing = false;
    isLoaded = !failLoad;
    volume = 1;
    currentTime = 0;
    duration = 200;
    removed = false;
    lockScreen = false;
    listener: ((status: AudioStatus) => void) | null = null;
    nativeError: string | null = failLoad ? "The stream couldn't be loaded." : null;
    constructor(readonly source: string) { created.push(this); }
    emit(extra: Partial<AudioStatus> = {}) {
      this.listener?.({ id: "player", currentTime: this.currentTime, playbackState: "readyToPlay", timeControlStatus: this.playing ? "playing" : "paused", reasonForWaitingToPlay: "", mute: false, duration: this.duration, playing: this.playing, loop: false, didJustFinish: false, isBuffering: false, isLoaded: this.isLoaded, playbackRate: 1, shouldCorrectPitch: false, isLive: false, currentOffsetFromLive: null, error: this.nativeError, ...extra });
    }
    addListener(_event: "playbackStatusUpdate", callback: (status: AudioStatus) => void) { this.listener = callback; this.emit(); return { remove: () => { this.listener = null; } }; }
    play() { this.playing = true; this.emit(); }
    pause() { this.playing = false; this.emit(); }
    async seekTo(seconds: number) { this.currentTime = seconds; this.emit(); }
    remove() { this.removed = true; }
    setActiveForLockScreen(active: boolean) { this.lockScreen = active; }
    updateLockScreenMetadata() {}
  }
  const engine = new PhonePlayback({
    create: source => new FakePlayer(source),
    activate: () => activate(),
    mediaUrl: source => `authenticated:${source}`,
    metadata: () => ({ title: "Song" }),
    ownsOutput: () => owned,
    transport: (action, details) => { transport.push({ action, details }); },
    changed: () => {},
  });
  return { engine, created, transport, loseOwnership: () => { owned = false; engine.release(); }, setActivate: (value: () => Promise<void>) => { activate = value; }, setFailure: (value: boolean) => { failLoad = value; } };
}

describe("phone output playback", () => {
  test("resumes the core's position, authenticates the media URL, and reports the original source", async () => {
    const h = harness();
    await h.engine.execute("select_native_audio_device", { deviceId: PHONE_DEVICE_ID });
    await h.engine.execute("load_native_audio", { source: "http://server/api/song/playlist.m3u8", positionSeconds: 42, autoplay: true });
    expect(h.created[0].source).toBe("authenticated:http://server/api/song/playlist.m3u8");
    expect(h.engine.status()).toMatchObject({ currentSource: "http://server/api/song/playlist.m3u8", currentTime: 42, isPlaying: true, buffering: false });
    expect(h.created[0].lockScreen).toBe(true);
    expect(h.transport).toEqual([]);
    h.engine.release();
  });

  test("core pause, seek, play and volume commands do not echo back as new transport commands", async () => {
    const h = harness();
    await h.engine.execute("load_native_audio", { source: "song", positionSeconds: 10, autoplay: true });
    await h.engine.execute("pause_native_audio", {});
    await h.engine.execute("seek_native_audio", { positionSeconds: 70 });
    await h.engine.execute("play_native_audio", {});
    await h.engine.execute("set_native_audio_volume", { volume: 35 });
    expect(h.engine.status()).toMatchObject({ currentTime: 70, isPlaying: true });
    expect(h.created[0].volume).toBe(0.35);
    expect(await h.engine.execute("native_audio_volume", {})).toBe(35);
    expect(h.transport).toEqual([]);
    h.engine.release();
  });

  test("native pause and seek update the shared session, while song completion is left to the core", async () => {
    const h = harness();
    await h.engine.execute("load_native_audio", { source: "song", autoplay: true });
    h.created[0].pause();
    await h.created[0].seekTo(85);
    expect(h.transport).toEqual([{ action: "pause", details: undefined }, { action: "seek", details: { positionSeconds: 85 } }]);
    h.created[0].emit({ didJustFinish: true, playing: false });
    expect(h.engine.status().ended).toBe(true);
    expect(h.transport).toHaveLength(2);
    h.engine.release();
  });

  test("changing output releases audio and ignores late native events", async () => {
    const h = harness();
    await h.engine.execute("load_native_audio", { source: "song", autoplay: true });
    const late = h.created[0].listener!;
    h.loseOwnership();
    expect(h.created[0].playing).toBe(false);
    expect(h.created[0].lockScreen).toBe(false);
    expect(h.created[0].removed).toBe(true);
    h.created[0].listener = late;
    h.created[0].emit({ playing: true, didJustFinish: true });
    expect(h.engine.status()).toMatchObject({ currentSource: null, isPlaying: false, ended: false });
    expect(h.transport).toEqual([]);
  });

  test("unpairing during activation prevents a late load from starting audio", async () => {
    const h = harness();
    let finish!: () => void;
    h.setActivate(() => new Promise<void>(resolve => { finish = resolve; }));
    const loading = h.engine.execute("load_native_audio", { source: "song", autoplay: true });
    h.loseOwnership();
    finish();
    await expect(loading).rejects.toThrow("no longer the selected output");
    expect(h.created).toHaveLength(0);
    expect(h.engine.status().currentSource).toBeNull();
  });

  test("a failed stream stays visibly failed and can be retried", async () => {
    const h = harness();
    h.setFailure(true);
    await expect(h.engine.execute("load_native_audio", { source: "song", autoplay: true })).rejects.toThrow("couldn't be loaded");
    h.created[0].emit({ error: null });
    expect(h.engine.status().error).toContain("couldn't be loaded");
    h.setFailure(false);
    await h.engine.execute("play_native_audio", {});
    expect(h.created).toHaveLength(2);
    expect(h.engine.status()).toMatchObject({ isPlaying: true, error: null });
    h.engine.release();
  });
});
