import { describe, expect, test } from "bun:test";
import type { MusicProvider } from "../src/types/music";
import { playbackCachePlan } from "../src/utils/playbackCachePlan";

function track(id: string, provider: MusicProvider = "tidal") {
  return {
    id,
    provider,
    providerTrackId: `${provider}-${id}`,
    durationSeconds: id.length * 10,
  };
}

describe("playbackCachePlan", () => {
  test("builds the current payload and exactly the next three positions", () => {
    const plan = playbackCachePlan(
      ["a", "b", "c", "d", "e", "f", "g"].map((id) => track(id)),
      "a",
    );

    expect(plan.current).toEqual({
      provider: "tidal",
      providerTrackId: "tidal-a",
      durationSeconds: 10,
    });
    expect(plan.upcoming.map(({ providerTrackId }) => providerTrackId)).toEqual(
      ["tidal-b", "tidal-c", "tidal-d"],
    );
  });

  test("wraps circularly without repeating positions beyond library length", () => {
    const plan = playbackCachePlan([track("a"), track("b"), track("c")], "b");

    expect(plan.upcoming.map(({ providerTrackId }) => providerTrackId)).toEqual(
      ["tidal-c", "tidal-a"],
    );
  });

  test("skips local payloads without looking past the three-position window", () => {
    const tracks = [
      track("current", "local"),
      track("one", "local"),
      track("two", "qobuz"),
      track("three", "local"),
      track("four", "spotify"),
      track("five", "local"),
      track("outside", "youtubeMusic"),
    ];

    const plan = playbackCachePlan(tracks, "current");

    expect(plan.current).toBeNull();
    expect(plan.upcoming.map(({ providerTrackId }) => providerTrackId)).toEqual(
      ["qobuz-two"],
    );
  });

  test("returns an empty plan when there is no effective current track", () => {
    expect(playbackCachePlan([track("a")], null)).toEqual({
      current: null,
      upcoming: [],
    });
  });
});
