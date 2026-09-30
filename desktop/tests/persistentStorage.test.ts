import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  flushPersistentState,
  hydratePersistentStorage,
  removePersistentItem,
  resetPersistenceForTests,
  setPersistentItem,
  type PersistenceBackend,
} from "../src/utils/persistentStorage";

const revisionKey = "ambra.persistence.updated-at-ms";
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let store: Map<string, string>;

type Saved = Parameters<PersistenceBackend["save"]>[0];

function fakeBackend(
  load: Awaited<ReturnType<PersistenceBackend["load"]>>,
  options: { delayMs?: number } = {},
) {
  const saves: Saved[] = [];
  const loads: number[] = [];
  const backend: PersistenceBackend = {
    load: async (known) => {
      loads.push(known);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return load;
    },
    save: async (patch) => {
      saves.push(patch);
    },
  };
  return { backend, saves, loads };
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  store = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});

afterEach(() => {
  resetPersistenceForTests();
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("persistent storage", () => {
  test("an up-to-date WebView hydrates without transferring or writing anything", async () => {
    store.set(revisionKey, "100");
    store.set("ambra.preferences", "local");
    const { backend, saves, loads } = fakeBackend({ updatedAtMs: 100, values: null });
    resetPersistenceForTests(backend, { writeDelayMs: 5 });

    expect(await hydratePersistentStorage()).toBe(false);
    await tick();

    expect(loads).toEqual([100]);
    expect(saves).toEqual([]);
    expect(store.get("ambra.preferences")).toBe("local");
  });

  test("hydration does not block synchronous reads and writes", async () => {
    const { backend } = fakeBackend(null, { delayMs: 40 });
    resetPersistenceForTests(backend, { writeDelayMs: 5 });

    const pending = hydratePersistentStorage();
    setPersistentItem("ambra.preferences", "early");
    expect(store.get("ambra.preferences")).toBe("early");
    await pending;
  });

  test("writes before hydration never make a stale WebView look newer than disk", async () => {
    store.set(revisionKey, "100");
    store.set("ambra.preferences", "stale");
    const { backend, saves } = fakeBackend(
      { updatedAtMs: 500, values: { "ambra.preferences": "durable" } },
      { delayMs: 20 },
    );
    resetPersistenceForTests(backend, { writeDelayMs: 5 });

    const pending = hydratePersistentStorage();
    setPersistentItem("ambra.preferences", "normalized-on-mount");
    expect(store.get(revisionKey)).toBe("100");

    expect(await pending).toBe(true);
    await tick();
    expect(store.get("ambra.preferences")).toBe("durable");
    expect(store.get(revisionKey)).toBe("500");
    expect(saves).toEqual([]);
  });

  test("restores a newer durable copy, removing keys it does not contain", async () => {
    store.set("ambra.queue.v1", "old-queue");
    const { backend } = fakeBackend({
      updatedAtMs: 900,
      values: { "ambra.playlists.v1": "lists" },
    });
    resetPersistenceForTests(backend, { writeDelayMs: 5 });

    expect(await hydratePersistentStorage()).toBe(true);
    expect(store.get("ambra.playlists.v1")).toBe("lists");
    expect(store.has("ambra.queue.v1")).toBe(false);
  });

  test("seeds the durable copy from this WebView when none exists", async () => {
    store.set("ambra.preferences", "mine");
    const { backend, saves } = fakeBackend(null);
    resetPersistenceForTests(backend, { writeDelayMs: 5 });

    await hydratePersistentStorage();
    await tick();

    expect(saves).toHaveLength(1);
    expect(saves[0].changes).toEqual({ "ambra.preferences": "mine" });
    expect(saves[0].updatedAtMs).toBeGreaterThan(0);
  });

  test("a durable copy that is behind is resynchronised", async () => {
    store.set(revisionKey, "300");
    store.set("ambra.preferences", "newer-local");
    const { backend, saves } = fakeBackend({ updatedAtMs: 100, values: null });
    resetPersistenceForTests(backend, { writeDelayMs: 5 });

    await hydratePersistentStorage();
    await tick();

    expect(saves).toHaveLength(1);
    expect(saves[0].updatedAtMs).toBe(300);
    expect(saves[0].changes["ambra.preferences"]).toBe("newer-local");
  });

  test("bursts coalesce into one patch containing only changed keys", async () => {
    store.set(revisionKey, "1");
    store.set("ambra.streaming-library.v1", "huge-library");
    const { backend, saves } = fakeBackend({ updatedAtMs: 1, values: null });
    resetPersistenceForTests(backend, { writeDelayMs: 10 });
    await hydratePersistentStorage();

    setPersistentItem("ambra.preferences", "a");
    setPersistentItem("ambra.preferences", "b");
    setPersistentItem("ambra.queue.v1", "q");
    removePersistentItem("ambra.library-order.v1"); // absent: a no-op
    expect(saves).toEqual([]);
    await tick(40);

    expect(saves).toHaveLength(1);
    expect(saves[0].changes).toEqual({ "ambra.preferences": "b", "ambra.queue.v1": "q" });
  });

  test("identical values do not bump the revision or reach the backend", async () => {
    store.set(revisionKey, "7");
    store.set("ambra.preferences", "same");
    const { backend, saves } = fakeBackend({ updatedAtMs: 7, values: null });
    resetPersistenceForTests(backend, { writeDelayMs: 5 });
    await hydratePersistentStorage();

    setPersistentItem("ambra.preferences", "same");
    await tick();

    expect(store.get(revisionKey)).toBe("7");
    expect(saves).toEqual([]);
  });

  test("removals are sent as null and flushing is immediate", async () => {
    store.set(revisionKey, "1");
    store.set("ambra.queue.v1", "q");
    const { backend, saves } = fakeBackend({ updatedAtMs: 1, values: null });
    resetPersistenceForTests(backend, { writeDelayMs: 60_000 });
    await hydratePersistentStorage();

    removePersistentItem("ambra.queue.v1");
    flushPersistentState();
    await tick();

    expect(saves).toHaveLength(1);
    expect(saves[0].changes).toEqual({ "ambra.queue.v1": null });
  });

  test("keys outside the durable set stay local-only", async () => {
    const { backend, saves } = fakeBackend({ updatedAtMs: 1, values: null });
    resetPersistenceForTests(backend, { writeDelayMs: 5 });
    await hydratePersistentStorage();

    setPersistentItem("some.other.key", "x");
    await tick();

    expect(store.get("some.other.key")).toBe("x");
    expect(saves).toEqual([]);
  });
});
