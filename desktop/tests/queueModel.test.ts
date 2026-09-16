import { describe, expect, test } from "bun:test";
import type { QueueItem, Track } from "../src/types/music";
import {
  contextEntry,
  contextEntriesFrom,
  searchQueueContext,
  shuffledContextEntries,
} from "../src/utils/queueModel";
import {
  advanceQueue,
  completeQueueTrack,
  jumpQueue,
  refreshQueueTracks,
  removeQueueEntries,
  rewindQueue,
} from "../src/utils/queueNavigation";
import {
  parseQueueSnapshot,
  queueSnapshot,
  resolveQueueSnapshot,
} from "../src/utils/queueStorage";

function track(globalId: string): Track {
  return {
    globalId,
    provider: "local",
    providerTrackId: globalId,
    playbackKind: "direct",
    audio: globalId,
    cover: "",
    nativeCover: null,
    name: globalId,
    version: null,
    album: "Test",
    albumVersion: null,
    albumId: null,
    albumArtists: [],
    artist: "Test",
    artists: [],
    trackNumber: null,
    discNumber: null,
    durationSeconds: 1,
    releaseDate: null,
    explicit: false,
    isrc: null,
    copyright: null,
    label: null,
    genres: [],
    upc: null,
    quality: null,
    maximumSamplingRateKHz: null,
    maximumBitDepth: null,
  };
}

function item(
  globalId: string,
  entryId: number,
  shufflePackageId: string | null = null,
): QueueItem {
  return {
    track: track(globalId),
    source: { kind: "playlist", id: "story", entryId },
    shufflePackageId,
  };
}

describe("queue model", () => {
  test("search results retain their own queue context", () => {
    const context = searchQueueContext(
      [track("tidal:1"), track("tidal:2")],
      "search:tidal:test",
    );

    expect(context.source).toEqual({
      kind: "search",
      id: "search:tidal:test",
    });
    expect(context.entries.map((entry) => entry.source.entryId)).toEqual([
      1, 2,
    ]);
  });

  test("refreshes queued tracks after deferred playback metadata arrives", () => {
    const current = item("tidal:1", 1);
    const resolved = {
      ...current.track,
      playbackKind: "dash" as const,
      audio: "/playlist.m3u8",
      quality: "FLAC 24-bit/96 kHz",
    };
    const state = { history: [], current, upcoming: [] };

    const refreshed = refreshQueueTracks(state, [resolved]);

    expect(refreshed.current?.track).toBe(resolved);
    expect(refreshQueueTracks(refreshed, [resolved])).toBe(refreshed);
  });

  test("a search menu selection stays playable after another provider replaces its result", () => {
    const selected = track("tidal:1");
    const visible = [track("qobuz:1")];
    const context = searchQueueContext(visible, "search:all:test", selected);

    expect(contextEntry(context, "tidal:1")?.track).toBe(selected);
    expect(contextEntry(context, "qobuz:1")?.track).toBe(visible[0]);
    expect(visible.map(track => track.globalId)).toEqual(["qobuz:1"]);
  });

  test("resolved search metadata replaces the selection without duplicating its queue entry", () => {
    const visible = [track("tidal:1"), track("qobuz:2")];
    const resolved = { ...visible[0], audio: "/resolved.m3u8", playbackKind: "dash" as const };
    const context = searchQueueContext(visible, "search:all:test", resolved);

    expect(context.entries).toHaveLength(2);
    expect(contextEntry(context, "tidal:1")?.track).toBe(resolved);
    expect(context.entries.map(entry => entry.track.globalId)).toEqual(["tidal:1", "qobuz:2"]);
    expect(visible[0].audio).toBe("tidal:1");
  });

  test("normal context playback ignores shuffle packages", () => {
    const entries = [item("a", 1), item("b", 2, "pair"), item("c", 3, "pair")];
    const context = {
      source: { kind: "playlist" as const, id: "story" },
      entries,
    };

    expect(
      contextEntriesFrom(context, "b").map((entry) => entry.track.globalId),
    ).toEqual(["b", "c"]);
  });

  test("shuffle keeps packaged songs together in source order", () => {
    const entries = [
      item("a", 1),
      item("b", 2, "pair"),
      item("c", 3, "pair"),
      item("d", 4),
    ];
    const shuffled = shuffledContextEntries(entries, () => 0);
    const ids = shuffled.map((entry) => entry.track.globalId);

    expect(ids).toHaveLength(entries.length);
    expect(new Set(ids)).toEqual(new Set(["a", "b", "c", "d"]));
    expect(ids.indexOf("c")).toBe(ids.indexOf("b") + 1);
  });

  test("JSON restoration resolves IDs and drops unavailable tracks", () => {
    const current = item("a", 1);
    const unavailable = item("missing", 2);
    const snapshot = queueSnapshot([], current, [unavailable]);
    const parsed = parseQueueSnapshot(JSON.stringify(snapshot));

    expect(parsed).not.toBeNull();
    const restored = resolveQueueSnapshot(parsed!, [current.track]);
    expect(restored.current?.track.globalId).toBe("a");
    expect(restored.upcoming).toEqual([]);
  });

  test("next and previous move through queue order without wrapping", () => {
    const first = item("a", 1);
    const second = item("b", 2);
    const third = item("c", 3);
    const initial = { history: [], current: first, upcoming: [second, third] };
    const archive = (entry: QueueItem) => ({
      ...entry,
      historyId: `history:${entry.track.globalId}`,
      playedAt: "2026-08-08T00:00:00.000Z",
    });

    const advanced = advanceQueue(initial, archive);
    expect(advanced.item?.track.globalId).toBe("b");
    expect(advanced.state.history.map((entry) => entry.track.globalId)).toEqual([
      "a",
    ]);
    expect(advanced.state.upcoming.map((entry) => entry.track.globalId)).toEqual([
      "c",
    ]);

    const rewound = rewindQueue(advanced.state);
    expect(rewound.item?.track.globalId).toBe("a");
    expect(rewound.state.upcoming.map((entry) => entry.track.globalId)).toEqual([
      "b",
      "c",
    ]);

    const exhausted = advanceQueue(
      { history: [], current: third, upcoming: [] },
      archive,
    );
    expect(exhausted.item).toBeUndefined();
    expect(exhausted.state.current?.track.globalId).toBe("c");

    const completed = completeQueueTrack(exhausted.state, archive);
    expect(completed.item).toBeUndefined();
    expect(completed.state.current).toBeNull();
    expect(completed.state.history.map((entry) => entry.track.globalId)).toEqual([
      "c",
    ]);
  });

  test("jumping to an upcoming item consumes only the existing queue", () => {
    const first = item("a", 1);
    const second = item("b", 2);
    const third = item("c", 3);
    const fourth = item("d", 4);
    const initial = {
      history: [],
      current: first,
      upcoming: [second, third, fourth],
    };
    const archive = (entry: QueueItem) => ({
      ...entry,
      historyId: `history:${entry.track.globalId}`,
      playedAt: "2026-08-11T00:00:00.000Z",
    });

    const jumped = jumpQueue(initial, 1, archive);

    expect(jumped.item?.track.globalId).toBe("c");
    expect(jumped.state.history.map((entry) => entry.track.globalId)).toEqual([
      "a",
      "b",
    ]);
    expect(jumped.state.current?.track.globalId).toBe("c");
    expect(jumped.state.upcoming.map((entry) => entry.track.globalId)).toEqual([
      "d",
    ]);
  });

  test("removing queue entries promotes the first remaining upcoming item", () => {
    const first = item("a", 1);
    const second = item("b", 2);
    const third = item("c", 3);
    const fourth = item("d", 4);
    const initial = {
      history: [],
      current: first,
      upcoming: [second, third, fourth],
    };

    const removed = removeQueueEntries(initial, new Set([1, 3]));

    expect(removed.currentRemoved).toBe(true);
    expect(removed.item?.track.globalId).toBe("b");
    expect(removed.state.current?.track.globalId).toBe("b");
    expect(removed.state.upcoming.map((entry) => entry.track.globalId)).toEqual([
      "d",
    ]);
    expect(removed.state.history).toEqual([]);
  });

  test("removing upcoming entries leaves the current item untouched", () => {
    const first = item("a", 1);
    const second = item("b", 2);
    const third = item("c", 3);
    const initial = { history: [], current: first, upcoming: [second, third] };

    const removed = removeQueueEntries(initial, new Set([2]));

    expect(removed.currentRemoved).toBe(false);
    expect(removed.state.current).toBe(first);
    expect(removed.state.upcoming).toEqual([third]);
  });
});
