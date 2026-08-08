import { describe, expect, test } from "bun:test";
import type { QueueItem, Track } from "../src/types/music";
import {
  contextEntriesFrom,
  shuffledContextEntries,
} from "../src/utils/queueModel";
import { advanceQueue, rewindQueue } from "../src/utils/queueNavigation";
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
  });
});
