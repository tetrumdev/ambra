import { afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { setServerForTesting } from "../src/api/serverConnection";
import { coreView, followCore, subscribeCore } from "../src/api/core";
import { applyQueuePatch, type QueuePatch } from "../src/utils/queuePatch";

const dom = new Window({ url: "http://localhost" });
beforeAll(() => { Object.assign(globalThis, { localStorage: dom.localStorage, window: dom, document: dom.document }); });

const item = (id: string) => ({ globalTrackId: id, source: { kind: "library" as const, id: "library", entryId: 1 }, shufflePackageId: null });
const played = (id: string) => ({ ...item(id), historyId: `h-${id}`, playedAt: "2026-01-01T00:00:00.000Z" });
const queue = (revision: number) => ({
  version: 1 as const, revision, history: [played("z")], current: item("a"), upcoming: [item("b"), item("c")],
  tracks: [{ globalId: "a", provider: "qobuz", audio: "http://server:38147/api/a" }] as never,
});
const session = (revision: number, queueRevision: number, extra: Record<string, unknown> = {}) => ({
  instanceId: "one", revision, playing: true, positionSeconds: revision, serverTimeMs: 0, duration: 200, buffering: false,
  error: null, audioQuality: null, output: null, outputOnline: false, queueRevision, ...extra,
});

test("a patch makes the queue the server has, sharing the songs it didn't change", () => {
  const before = queue(4);
  const advance: QueuePatch = { base: 4, revision: 5, historyDropFront: 1, historyDropBack: 0, historyPush: [played("a")], current: item("b"), upcomingDropFront: 1, upcomingUnshift: [] };
  const advanced = applyQueuePatch(before, advance);
  expect(advanced).toEqual({ ...before, revision: 5, history: [played("a")], current: item("b"), upcoming: [item("c")] });
  expect(advanced.tracks).toBe(before.tracks);
  const rewind: QueuePatch = { base: 5, revision: 6, historyDropFront: 0, historyDropBack: 1, historyPush: [], current: item("a"), upcomingDropFront: 0, upcomingUnshift: [item("b")] };
  expect(applyQueuePatch(advanced, rewind)).toEqual({ ...before, revision: 6, history: [], current: item("a"), upcoming: [item("b"), item("c")] });
  const finish: QueuePatch = { base: 4, revision: 5, historyDropFront: 0, historyDropBack: 0, historyPush: [played("a")], current: null, upcomingDropFront: 2, upcomingUnshift: [] };
  expect(applyQueuePatch(before, finish)).toEqual({ ...before, revision: 5, history: [played("z"), played("a")], current: null, upcoming: [] });
  expect(before.history).toEqual([played("z")]);
});

const original = globalThis.fetch;
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; globalThis.fetch = original; });

test("the stream is followed with patches, asking for the whole queue only when it has to", async () => {
  setServerForTesting("http://selected:38147", null);
  const requests: string[] = [];
  let send!: (view: unknown) => void;
  let answerQueue: ((revision: number) => void) | undefined;
  let served = { revision: 1, queueRevision: 4 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace("http://selected:38147", "");
    if (url.startsWith("/api/session/clock")) return Response.json({ serverTimeMs: 0 });
    requests.push(url);
    if (url.startsWith("/api/session/stream")) {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          send = view => controller.enqueue(encoder.encode(`${JSON.stringify(view)}\n`));
          init?.signal?.addEventListener("abort", () => { try { controller.error(new Error("aborted")); } catch { /* Already closed. */ } });
        },
      }));
    }
    // The whole session: answered when the test says so, like a slow connection.
    return new Promise<Response>(resolve => {
      answerQueue = () => resolve(Response.json(session(served.revision, served.queueRevision, { queue: queue(served.queueRevision) })));
    });
  }) as typeof fetch;
  let changes = 0;
  const unsubscribe = subscribeCore(() => { changes += 1; });
  stop = followCore();
  const settle = () => new Promise(resolve => setTimeout(resolve, 15));
  await settle();
  expect(requests[0]).toBe("/api/session/stream?patches=1");

  // No queue here yet: several views arrive while the one request for it is still out.
  send(session(1, 4));
  send(session(2, 4));
  send(session(3, 4));
  await settle();
  expect(requests.filter(url => url === "/api/session")).toHaveLength(1);
  expect(coreView()).toBeNull();
  served = { revision: 3, queueRevision: 4 };
  answerQueue!(4);
  await settle();
  expect(coreView()?.queue.current?.globalTrackId).toBe("a");
  const songs = coreView()!.queue.tracks;

  // The server moves on a song: three entries change, and nothing is asked for.
  changes = 0;
  send(session(4, 5, { queuePatch: { base: 4, revision: 5, historyDropFront: 0, historyDropBack: 0, historyPush: [played("a")], current: item("b"), upcomingDropFront: 1, upcomingUnshift: [] } }));
  await settle();
  expect(coreView()?.queueRevision).toBe(5);
  expect(coreView()?.queue.current?.globalTrackId).toBe("b");
  expect(coreView()?.queue.upcoming).toEqual([item("c")]);
  expect(coreView()?.queue.history).toHaveLength(2);
  expect(coreView()?.queue.tracks).toBe(songs);
  expect(changes).toBe(1);
  expect(requests.filter(url => url === "/api/session")).toHaveLength(1);

  // Only the position moved: read by those who sample it, with nothing redrawn.
  send(session(5, 5));
  await settle();
  expect(coreView()?.positionSeconds).toBe(5);
  expect(changes).toBe(1);

  // A patch for a queue this app doesn't have (it missed a revision) can't be applied.
  served = { revision: 6, queueRevision: 7 };
  send(session(6, 7, { queuePatch: { base: 6, revision: 7, historyDropFront: 0, historyDropBack: 0, historyPush: [], current: item("c"), upcomingDropFront: 1, upcomingUnshift: [] } }));
  await settle();
  expect(requests.filter(url => url === "/api/session")).toHaveLength(2);
  expect(coreView()?.queueRevision).toBe(5);
  answerQueue!(7);
  await settle();
  expect(coreView()?.queueRevision).toBe(7);
  unsubscribe();
});
