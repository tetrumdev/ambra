import { describe, expect, test } from "bun:test";
import type { MobilePlaylist, QueueSnapshot, Track } from "../../mobile/src/client";
import { editUpcoming, enqueueEntries, playEntries, playlistEntries, shuffledEntries } from "../../mobile/src/queueModel";

const tracks: Track[] = ["a", "b", "c", "d"].map(globalId => ({ globalId, provider: "qobuz", name: globalId, artist: "Artist", album: "Album", cover: "", nativeCover: null, durationSeconds: 180 }));
const playlist: MobilePlaylist = { id: "mega", name: "MEGA", trackIds: tracks.map(track => track.globalId), packages: [["a", "b"]] };
const entries = playlistEntries(playlist, tracks);
const queue: QueueSnapshot = { version: 1, history: [], current: entries[3], upcoming: [entries[2], entries[2], entries[0]], tracks };

describe("mobile shared queue", () => {
  test("shuffle keeps bound songs together and preserves source positions", () => {
    const shuffled = shuffledEntries(entries, () => 0);
    expect(shuffled.map(item => item.globalTrackId)).toEqual(["c", "d", "a", "b"]);
    expect(shuffled[2].source).toEqual({ kind: "playlist", id: "mega", entryId: 1 });
    expect(new Set(shuffled.map(item => item.globalTrackId)).size).toBe(4);
  });

  test("playing from a song replaces upcoming and archives the current song", () => {
    const next = playEntries(queue, entries.slice(1), tracks);
    expect(next.current?.globalTrackId).toBe("b");
    expect(next.upcoming.map(item => item.globalTrackId)).toEqual(["c", "d"]);
    expect(next.history?.at(-1)?.globalTrackId).toBe("d");
    expect(queue.history).toEqual([]);
  });

  test("play next and add to queue retain duplicates and other queued songs", () => {
    expect(enqueueEntries(queue, [entries[1]], tracks, true).upcoming.map(item => item.globalTrackId)).toEqual(["b", "c", "c", "a"]);
    expect(enqueueEntries(queue, [entries[1]], tracks).upcoming.map(item => item.globalTrackId)).toEqual(["c", "c", "a", "b"]);
    expect(enqueueEntries({ current: null, upcoming: [] }, entries, tracks).current?.globalTrackId).toBe("a");
  });

  test("remove targets one occurrence and play jumps past earlier upcoming songs", () => {
    expect(editUpcoming(queue, 7, 7, 1, "remove").upcoming.map(item => item.globalTrackId)).toEqual(["c", "a"]);
    const next = editUpcoming(queue, 7, 7, 1, "play");
    expect(next.current?.globalTrackId).toBe("c");
    expect(next.upcoming.map(item => item.globalTrackId)).toEqual(["a"]);
    expect(next.history?.at(-1)?.globalTrackId).toBe("d");
  });

  test("positional edits refuse a changed revision instead of affecting the wrong song", () => {
    expect(() => editUpcoming(queue, 8, 7, 1, "remove")).toThrow("changed on another device");
    expect(() => editUpcoming(queue, 8, 7, 1, "play")).toThrow("changed on another device");
  });

  test("empty collections leave playback alone and previous history stays bounded", () => {
    expect(playEntries(queue, [], [])).toBe(queue);
    const history = Array.from({ length: 100 }, (_, index) => ({ ...entries[0], historyId: String(index), playedAt: "2026-10-26T00:00:00Z" }));
    const next = playEntries({ ...queue, history }, entries, tracks);
    expect(next.history).toHaveLength(100);
    expect(next.history?.[0].historyId).toBe("1");
  });
});
