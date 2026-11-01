import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Track } from "../src/types/music";
import type { QueueState } from "../src/utils/queueNavigation";
import type { QueueController } from "../src/hooks/useQueue";

const listeners = new Set<() => void>();
let confirmed: QueueState & { revision: number };
let view = { queue: {}, revision: 1 };
let resolveCommand: () => void;
let rejectCommand: (error: Error) => void;
let commands: string[] = [];
const expiredTimers: (() => void)[] = [];
const originalSetTimeout = globalThis.setTimeout;

mock.module("../src/api/core", () => ({
  coreView: () => view,
  coreQueue: () => confirmed,
  subscribeCore: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  coreChangeQueue: async () => {},
  coreCommand: (command: string) => {
    commands.push(command);
    return new Promise<void>((resolve, reject) => { resolveCommand = resolve; rejectCommand = reject; });
  },
}));
const { useCoreQueue } = await import("../src/hooks/useCoreQueue");

const tracks = ["first", "second", "third"].map((id): Track => ({
  globalId: `qobuz:${id}`, provider: "qobuz", providerTrackId: id, playbackKind: "direct",
  audio: `http://server:38147/api/providers/qobuz/tracks/${id}/stream`, cover: "", nativeCover: null,
  name: id, version: null, album: "Album", albumVersion: null, albumId: null, albumArtists: [],
  artist: "Artist", artists: [], trackNumber: null, discNumber: null, durationSeconds: 180,
  releaseDate: null, explicit: false, isrc: null, copyright: null, label: null, genres: [],
  upc: null, quality: null, maximumSamplingRateKHz: null, maximumBitDepth: null,
}));
const entries = tracks.map((track, index) => ({
  track, source: { kind: "playlist" as const, id: "test", entryId: index + 1 }, shufflePackageId: null,
}));
const dom = new Window({ url: "http://localhost/" });
let queue: QueueController;

function Harness() {
  queue = useCoreQueue(tracks);
  return createElement("div", null, queue.currentEntry?.track.name);
}

function publish(state: QueueState, revision: number) {
  confirmed = { ...state, revision };
  view = { queue: state, revision: view.revision + 1 };
  for (const listener of listeners) listener();
}

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    setTimeout: (callback: () => void, delay: number, ...args: unknown[]) => {
      if (delay === 5000) { expiredTimers.push(callback); return 0; }
      return originalSetTimeout(callback, delay, ...args);
    },
  });
});
beforeEach(() => {
  confirmed = { current: entries[0], upcoming: entries.slice(1), history: [], revision: 1 };
  view = { queue: confirmed, revision: 1 };
  commands = [];
  expiredTimers.length = 0;
});
afterAll(() => { globalThis.setTimeout = originalSetTimeout; dom.happyDOM.abort(); });

async function mount() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
  return { container, unmount: () => act(async () => root.unmount()) };
}

test("an audible local skip does not revert when the server takes longer to confirm it", async () => {
  const mounted = await mount();
  try {
    await act(async () => { queue.next(false); });
    expect(mounted.container.textContent).toBe("second");
    await act(async () => {
      for (const callback of expiredTimers.splice(0)) callback();
      publish(confirmed, 1);
    });
    expect(mounted.container.textContent).toBe("second");
    expect(queue.historyEntries.map(entry => entry.track.name)).toEqual(["first"]);
    expect(queue.peekNext()?.track.name).toBe("third");
    expect(commands).toEqual([]);
    const advanced = { current: queue.currentEntry!, upcoming: queue.upcomingEntries, history: queue.historyEntries };
    await act(async () => publish(advanced, 2));
    expect(mounted.container.textContent).toBe("second");
    expect(queue.historyEntries).toHaveLength(1);
  } finally { await mounted.unmount(); }
});

test("successive audible skips keep the latest song while confirmation is delayed", async () => {
  const mounted = await mount();
  try {
    await act(async () => { queue.next(false); });
    await act(async () => { queue.next(false); });
    await act(async () => { for (const callback of expiredTimers.splice(0)) callback(); });
    expect(mounted.container.textContent).toBe("third");
    expect(queue.historyEntries.map(entry => entry.track.name)).toEqual(["first", "second"]);
    expect(queue.upcomingEntries).toHaveLength(0);
  } finally { await mounted.unmount(); }
});

test("a newer authoritative queue can replace a locally advanced song", async () => {
  const mounted = await mount();
  try {
    await act(async () => { queue.next(false); });
    await act(async () => publish({ current: entries[2], upcoming: [], history: [] }, 2));
    expect(mounted.container.textContent).toBe("third");
  } finally { await mounted.unmount(); }
});

test("a failed server skip still restores the authoritative song", async () => {
  const mounted = await mount();
  try {
    await act(async () => { queue.next(); });
    expect(mounted.container.textContent).toBe("second");
    await act(async () => rejectCommand(new Error("Output unavailable")));
    expect(mounted.container.textContent).toBe("first");
    expect(commands).toEqual(["next"]);
  } finally { await mounted.unmount(); }
});

test("a confirmed server skip retains the acknowledged song", async () => {
  const mounted = await mount();
  try {
    await act(async () => { queue.next(); });
    const advanced = { current: queue.currentEntry!, upcoming: queue.upcomingEntries, history: queue.historyEntries };
    await act(async () => { publish(advanced, 2); resolveCommand(); });
    expect(mounted.container.textContent).toBe("second");
    expect(queue.historyEntries).toHaveLength(1);
  } finally { await mounted.unmount(); }
});
