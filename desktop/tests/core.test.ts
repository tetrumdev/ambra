import { expect, test } from "bun:test";
import { coreChangeQueue, coreCommand, coreQueue, coreView, type CoreView } from "../src/api/core";
import { setServerForTesting } from "../src/api/serverConnection";
import { nativeAudioSource } from "../src/utils/nativeAudioSource";
import type { Track } from "../src/types/music";

test("shared queue edits travel with play, retry against the returned queue and discard late views", async () => {
  setServerForTesting("http://192.168.1.20:38147", "device-token");
  const original = globalThis.fetch;
  const calls: Array<{ action?: string; playTrackId?: string; base?: number }> = [];
  const session = (revision: number): CoreView => ({
    instanceId: "server-start-1",
    revision, playing: false, positionSeconds: 0, duration: 10, buffering: false,
    error: null, audioQuality: null, output: null, outputOnline: false, queueRevision: revision,
    queue: { version: 1, revision, history: [], current: null, upcoming: [], tracks: [] },
  });
  let current = session(1);
  let conflict = false;
  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (String(input).endsWith("/queue")) {
      if (conflict) {
        conflict = false;
        current = session(3);
        return Response.json({ error: "changed", session: current }, { status: 409 });
      }
      expect(body.base).toBe(current.queueRevision);
      current = { ...current, revision: current.revision + 1, queueRevision: current.queueRevision + 1, queue: { ...body.queue, revision: current.queueRevision + 1 } };
    }
    return Response.json(current);
  }) as typeof fetch;
  try {
    await coreCommand("pause");
    const track = {
      globalId: "local:hash", providerTrackId: "hash.flac", provider: "local", playbackKind: "direct",
      audio: "/api/music/local/files/hash.flac", cover: "/white.svg", nativeCover: null,
      name: "Song", artist: "Artist", album: "Album", durationSeconds: 10, artists: [], albumArtists: [],
    } as unknown as Track;
    const entry = { track, source: { kind: "library" as const, id: "library", entryId: 1 }, shufflePackageId: null };
    const queued = coreChangeQueue(() => [], state => ({ ...state, current: entry }));
    const playing = coreCommand("playTrack", { trackId: track.globalId });
    await Promise.all([queued, playing]);
    expect(calls).toHaveLength(2);
    expect(calls[1].playTrackId).toBe(track.globalId);
    expect(coreQueue([]).current?.track.audio).toBe("http://192.168.1.20:38147/api/music/local/files/hash.flac?access_token=device-token");
    expect(nativeAudioSource(coreQueue([]).current!.track)).toBe(coreQueue([]).current!.track.audio);
    conflict = true;
    await coreChangeQueue(() => [], state => ({ ...state, current: entry }));
    expect(calls.slice(-2).map(call => call.base)).toEqual([2, 3]);
    current = session(1);
    await coreCommand("pause");
    expect(coreView()?.revision).toBe(4);
    current = { ...session(1), instanceId: "server-start-2" };
    await coreCommand("pause");
    expect(coreView()?.revision).toBe(1);
    expect(coreView()?.instanceId).toBe("server-start-2");
  } finally {
    globalThis.fetch = original;
  }
});
