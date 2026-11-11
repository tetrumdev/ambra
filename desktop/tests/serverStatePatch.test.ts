import { afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { setServerForTesting } from "../src/api/serverConnection";
import { getServerItem, hydrateServerState, patchedValue, resetServerState } from "../src/utils/serverState";

const dom = new Window({ url: "http://localhost" });
beforeAll(() => { Object.assign(globalThis, { localStorage: dom.localStorage, window: dom, document: dom.document }); });

const HISTORY = "ambra.listening-history.v1";
const entry = (id: string, playCount = 1) => ({ track: { globalId: id, name: id }, lastPlayedAt: 1000, playCount });
const history = (...entries: unknown[]) => JSON.stringify({ version: 1, entries });

test("a play moves its song to the front of the history this app holds", () => {
  const before = history(entry("a"), entry("b", 4), entry("c"));
  expect(JSON.parse(patchedValue(HISTORY, before, { play: entry("b", 5) })!)).toEqual(JSON.parse(history(entry("b", 5), entry("a"), entry("c"))));
  expect(JSON.parse(patchedValue(HISTORY, before, { play: entry("new") })!).entries.map((played: { track: { globalId: string } }) => played.track.globalId)).toEqual(["new", "a", "b", "c"]);
  // Nothing to make it from, or not a change this app knows how to make.
  expect(patchedValue(HISTORY, undefined, { play: entry("b") })).toBeNull();
  expect(patchedValue(HISTORY, "not json", { play: entry("b") })).toBeNull();
  expect(patchedValue(HISTORY, before, { somethingNewer: true })).toBeNull();
  expect(patchedValue("ambra.playlists.v1", before, { play: entry("b") })).toBeNull();
});

const original = globalThis.fetch;
afterEach(() => { resetServerState(); globalThis.fetch = original; });

test("the history is followed by patches, and asked for whole when one can't be applied", async () => {
  setServerForTesting("http://patched:38147", null);
  const requested: string[] = [];
  const polls: ((value: unknown) => void)[] = [];
  let whole: unknown = null;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const query = String(input).replace("http://patched:38147/api/state", "");
    requested.push(query);
    if (!query) return Response.json({ revision: 7, values: { [HISTORY]: history(entry("a"), entry("b")) } });
    if (query.includes("wait=")) return new Promise<Response>(resolve => polls.push(value => resolve(Response.json(value))));
    return Response.json(whole);
  }) as typeof fetch;
  await hydrateServerState();
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  await settle();
  expect(requested[1]).toBe("?since=7&wait=25&without=ambra.queue.v1&patches=1");

  polls.shift()!({ revision: 8, changes: {}, patches: { [HISTORY]: { play: entry("b", 2) } } });
  await settle();
  expect(JSON.parse(getServerItem(HISTORY)!)).toEqual(JSON.parse(history(entry("b", 2), entry("a"))));
  expect(requested.at(-1)).toBe("?since=8&wait=25&without=ambra.queue.v1&patches=1");

  // A kind of patch this version doesn't know: the value is asked for as it is.
  whole = { revision: 9, changes: { [HISTORY]: history(entry("z")) } };
  polls.shift()!({ revision: 9, changes: {}, patches: { [HISTORY]: { somethingNewer: true } } });
  await settle();
  expect(requested).toContain("?since=8&without=ambra.queue.v1");
  expect(getServerItem(HISTORY)).toBe(history(entry("z")));
  expect(requested.at(-1)).toBe("?since=9&wait=25&without=ambra.queue.v1&patches=1");
});
