import { expect, test } from "bun:test";
import type { Track } from "../src/types/music";
import { playbackRestore } from "../src/utils/playbackRestore";

const first = { globalId: "first", durationSeconds: 240 } as Track;
const saved = { globalId: "saved", durationSeconds: 300 } as Track;
const session = { trackId: "saved", positionSeconds: 123 };

test("waits for the saved track instead of replacing it with the first result", () => {
  expect(playbackRestore([], session)).toBeNull();
  expect(playbackRestore([first], session)).toBeNull();
  expect(playbackRestore([first, saved], session)).toEqual({
    track: saved,
    position: 123,
  });
});

test("restores the displayed position before media starts playing", () => {
  const restored = playbackRestore([saved], session)!;
  expect(restored.position / restored.track.durationSeconds).toBe(0.41);
});

test("limits the restored position to the known duration", () => {
  expect(playbackRestore([saved], { ...session, positionSeconds: 400 })?.position).toBe(300);
});

test("uses the first track only when there is no saved selection", () => {
  expect(playbackRestore([first], { trackId: null, positionSeconds: 0 })).toEqual({
    track: first,
    position: 0,
  });
});
