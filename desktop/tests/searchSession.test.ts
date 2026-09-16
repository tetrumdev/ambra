import { describe, expect, test } from "bun:test";
import { SearchSession, type SearchSnapshot } from "../src/utils/searchSession";
import { track } from "./searchFixture";
import type { SearchPage } from "../src/api/server";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("independent search sources", () => {
  test("default buffer publishes tracks, portraits, and albums together after the slower service", async () => {
    const slow = deferred<SearchPage>();
    const updates: SearchSnapshot[] = [];
    const session = new SearchSession({ query: "deadman", providers: ["tidal", "qobuz"], combined: true, onUpdate: value => updates.push(value), fetchPage: async (_, provider) => provider === "qobuz" ? slow.promise : {
      tracks: [track("tidal:1", "tidal")],
      artists: [{ id: "tidal:artist", provider: "tidal", name: "Karnivool", imageUrl: "tidal-portrait.jpg" }],
      albums: [{ id: "tidal:album", provider: "tidal", title: "Sound Awake", artist: "Karnivool", imageUrl: "tidal-cover.jpg" }],
      nextOffset: null,
    } });
    const pending = session.loadMore();
    try {
      await new Promise(resolve => setTimeout(resolve, 650));
      expect(updates.every(update => !update.results.length && !update.artists.length && !update.albums.length && !update.candidates.length)).toBe(true);
      expect(updates[updates.length - 1]?.isSearching).toBe(true);
      slow.resolve({ tracks: [track("qobuz:1", "qobuz", { quality: "FLAC", maximumBitDepth: 24 })], nextOffset: null });
      await pending;
      expect(session.snapshot().results[0]?.globalId).toBe("qobuz:1");
      expect(session.snapshot().candidates).toHaveLength(2);
      const visible = updates.filter(update => update.results.length);
      expect(visible).toHaveLength(1);
      expect(visible[0].results[0]?.globalId).toBe("qobuz:1");
      expect(visible[0].artists).toHaveLength(1);
      expect(visible[0].albums).toHaveLength(1);
      expect(visible[0].isSearching).toBe(false);
    } finally {
      session.cancel();
      await pending;
    }
  });
  test("can publish Qobuz before TIDAL when the merge window is disabled", async () => {
    const slow = deferred<SearchPage>();
    const updates: SearchSnapshot[] = [];
    const session = new SearchSession({ query: "deadman", providers: ["tidal", "qobuz"], combined: true, initialMergeWindowMs: 0, onUpdate: value => updates.push(value), fetchPage: async (_, provider) => provider === "tidal" ? slow.promise : { tracks: [track("qobuz:1", "qobuz")], nextOffset: null } });
    const pending = session.loadMore();
    await tick();
    expect(updates[updates.length - 1]?.results[0]?.globalId).toBe("qobuz:1");
    expect(updates[updates.length - 1]?.isSearching).toBe(true);
    slow.resolve({ tracks: [], nextOffset: null });
    await pending;
    expect(session.snapshot().isSearching).toBe(false);
  });
  test("works with each service alone, including Spotify", async () => {
    for (const provider of ["qobuz", "tidal", "spotify"] as const) {
      const called: string[] = [];
      const session = new SearchSession({ query: "deadman", providers: [provider], combined: true, onUpdate: () => {}, fetchPage: async (_, source) => { called.push(source); return { tracks: [track(`${source}:1`, source)], nextOffset: null }; } });
      await session.loadMore();
      expect(called).toEqual([provider]);
      expect(session.snapshot().results).toHaveLength(1);
    }
  });
  test("retains successful results and retries a failed service without refetching exhausted services", async () => {
    let attempts = 0;
    const called: string[] = [];
    const session = new SearchSession({ query: "deadman", providers: ["qobuz", "tidal"], combined: true, onUpdate: () => {}, fetchPage: async (_, provider) => {
      called.push(provider);
      if (provider === "tidal" && attempts++ === 0) throw new Error("Unavailable");
      return { tracks: [track(`${provider}:1`, provider)], nextOffset: null };
    } });
    await session.loadMore();
    expect(session.snapshot().results).toHaveLength(1);
    expect(session.snapshot().canRetry).toBe(true);
    await session.retry();
    expect(called.filter(p => p === "qobuz")).toHaveLength(1);
    expect(session.snapshot().error).toBeNull();
    expect(session.snapshot().candidates).toHaveLength(2);
  });
  test("uses independent cursors and never automatically fetches all pages", async () => {
    const calls: Array<[string, number]> = [];
    const session = new SearchSession({ query: "deadman", providers: ["qobuz", "tidal"], combined: true, onUpdate: () => {}, fetchPage: async (_, provider, __, offset) => {
      calls.push([provider, offset]);
      return { tracks: [], nextOffset: offset === 0 ? (provider === "qobuz" ? 7 : 20) : null };
    } });
    await session.loadMore();
    expect(calls).toEqual([["qobuz", 0], ["tidal", 0]]);
    expect(session.snapshot().hasMore).toBe(true);
    await session.loadMore();
    expect(calls.slice(2)).toEqual([["qobuz", 7], ["tidal", 20]]);
    expect(session.snapshot().hasMore).toBe(false);
  });
  test("cancellation suppresses late updates, even when an upstream ignores abort", async () => {
    const late = deferred<SearchPage>();
    let updates = 0;
    const session = new SearchSession({ query: "deadman", providers: ["qobuz"], combined: true, onUpdate: () => { updates++; }, fetchPage: () => late.promise });
    const pending = session.loadMore();
    session.cancel();
    const atCancel = updates;
    late.resolve({ tracks: [track("qobuz:late", "qobuz")], nextOffset: null });
    await pending;
    expect(updates).toBe(atCancel);
    expect(session.snapshot().candidates).toHaveLength(0);
  });
  test("timeout does not discard other sources", async () => {
    const session = new SearchSession({ query: "deadman", providers: ["tidal", "qobuz"], combined: true, timeoutMs: 10, onUpdate: () => {}, fetchPage: async (_, provider) => provider === "tidal" ? new Promise(() => {}) : { tracks: [track("qobuz:1", "qobuz")], nextOffset: null } });
    await session.loadMore();
    expect(session.snapshot().results).toHaveLength(1);
    expect(session.snapshot().error).toContain("timed out");
    expect(session.snapshot().isSearching).toBe(false);
  });
  test("repeated load-more calls do not duplicate in-flight requests", async () => {
    const page = deferred<SearchPage>();
    let calls = 0;
    const session = new SearchSession({ query: "deadman", providers: ["qobuz"], combined: true, onUpdate: () => {}, fetchPage: () => { calls++; return page.promise; } });
    const pending = session.loadMore();
    await session.loadMore();
    expect(calls).toBe(1);
    page.resolve({ tracks: [], nextOffset: null });
    await pending;
  });
  test("bad cursors cannot create an endless pagination loop", async () => {
    const session = new SearchSession({ query: "deadman", providers: ["qobuz"], combined: true, onUpdate: () => {}, fetchPage: async () => ({ tracks: [], nextOffset: 0 }) });
    await session.loadMore();
    expect(session.snapshot().hasMore).toBe(false);
    expect(session.snapshot().error).toContain("cursor");
  });
  test("new quality information reranks editions while keeping both candidates", async () => {
    const a = track("tidal:1", "tidal");
    const b = track("qobuz:1", "qobuz", { quality: "FLAC", maximumBitDepth: 16 });
    const session = new SearchSession({ query: "deadman", providers: ["qobuz", "tidal"], combined: true, onUpdate: () => {}, fetchPage: async (_, provider) => ({ tracks: [provider === "tidal" ? a : b], nextOffset: null }) });
    await session.loadMore();
    expect(session.snapshot().results[0]?.globalId).toBe(b.globalId);
    session.replaceTrack({ ...a, quality: "FLAC", maximumBitDepth: 24 });
    expect(session.snapshot().results[0]?.globalId).toBe(a.globalId);
    expect(session.snapshot().candidates).toHaveLength(2);
  });
  test("no connected services is distinguishable from no matches", async () => {
    const session = new SearchSession({ query: "deadman", providers: [], combined: true, onUpdate: () => {}, fetchPage: async () => { throw new Error("Must not query"); } });
    await session.loadMore();
    expect(session.snapshot().error).toBe("No music services are connected.");
  });
  test("holds the first result briefly so a better edition appears without a source swap", async () => {
    const slower = deferred<SearchPage>();
    const updates: SearchSnapshot[] = [];
    const session = new SearchSession({ query: "deadman", providers: ["tidal", "qobuz"], combined: true, onUpdate: value => updates.push(value), fetchPage: async (_, provider) => provider === "qobuz" ? slower.promise : { tracks: [track("tidal:1", "tidal")], nextOffset: null } });
    const pending = session.loadMore();
    await tick();
    expect(updates[updates.length - 1]?.results).toHaveLength(0);
    slower.resolve({ tracks: [track("qobuz:1", "qobuz", { quality: "FLAC", maximumBitDepth: 24 })], nextOffset: null });
    await pending;
    expect(updates.filter(update => update.results.length).every(update => update.results[0]?.globalId === "qobuz:1")).toBe(true);
    expect(updates[updates.length - 1]?.results[0]?.globalId).toBe("qobuz:1");
  });
  test("the merge window expires before a stalled provider completes", async () => {
    const stalled = deferred<SearchPage>();
    const updates: SearchSnapshot[] = [];
    const session = new SearchSession({ query: "deadman", providers: ["tidal", "qobuz"], combined: true, initialMergeWindowMs: 5, onUpdate: value => updates.push(value), fetchPage: async (_, provider) => provider === "qobuz" ? stalled.promise : { tracks: [track("tidal:1", "tidal")], nextOffset: null } });
    const pending = session.loadMore();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(updates[updates.length - 1]?.results[0]?.globalId).toBe("tidal:1");
    expect(updates[updates.length - 1]?.isSearching).toBe(true);
    session.cancel();
    await pending;
  });

  test("the overall deadline bounds the buffer and late provider results still merge", async () => {
    const slow = deferred<SearchPage>();
    const updates: SearchSnapshot[] = [];
    const session = new SearchSession({ query: "deadman", providers: ["tidal", "qobuz"], combined: true,
      initialMergeWindowMs: 1000, initialDeadlineMs: 20,
      onUpdate: value => updates.push(value),
      fetchPage: async (_, provider) => provider === "qobuz" ? slow.promise : { tracks: [track("tidal:1", "tidal")], nextOffset: null },
    });
    const pending = session.loadMore();
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(updates[updates.length - 1]?.results[0]?.globalId).toBe("tidal:1");
      expect(updates[updates.length - 1]?.isSearching).toBe(true);
      slow.resolve({ tracks: [track("qobuz:1", "qobuz", { quality: "FLAC", maximumBitDepth: 24 })], nextOffset: null });
      await pending;
      expect(updates[updates.length - 1]?.results[0]?.globalId).toBe("qobuz:1");
      expect(updates[updates.length - 1]?.candidates).toHaveLength(2);
    } finally {
      session.cancel();
      await pending;
    }
  });

  test("cancelling a buffered search prevents its timers from publishing old results", async () => {
    const updates: SearchSnapshot[] = [];
    const session = new SearchSession({ query: "deadman", providers: ["tidal", "qobuz"], combined: true,
      initialMergeWindowMs: 20, initialDeadlineMs: 30,
      onUpdate: value => updates.push(value),
      fetchPage: async (_, provider) => provider === "qobuz" ? new Promise(() => {}) : { tracks: [track("tidal:1", "tidal")], nextOffset: null },
    });
    const pending = session.loadMore();
    await tick();
    expect(updates[updates.length - 1]?.results).toHaveLength(0);
    session.cancel();
    const atCancel = updates.length;
    await pending;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(updates).toHaveLength(atCancel);
  });

});
