import { beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { getPersistentItem, hydratePersistentStorage, setPersistentItem } from "../src/utils/persistentStorage";
import { getServerItem, hydrateServerState, setServerItem } from "../src/utils/serverState";
import { setServerForTesting } from "../src/api/serverConnection";
const dom = new Window({ url: "http://localhost" });
beforeAll(() => { Object.assign(globalThis, { localStorage: dom.localStorage, window: dom, document: dom.document }); });
test("local playlists, queue, settings and history persist without any server", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; throw new TypeError("Offline"); }) as typeof fetch;
  await hydratePersistentStorage();
  for (const key of ["ambra.playlists.v1", "ambra.queue.v1", "ambra.ui-preferences.v1", "ambra.playback.v1", "ambra.listening-history.v1"]) {
    setPersistentItem(key, JSON.stringify({ retained: key }));
    expect(getPersistentItem(key)).toBe(JSON.stringify({ retained: key }));
    expect(getServerItem(key)).toBeNull();
  }
  expect(calls).toBe(0);
  globalThis.fetch = original;
});
test("server hydration never imports, replaces or clears device state", async () => {
  const original = globalThis.fetch;
  let writes = 0;
  setServerForTesting("http://selected:38147", null);
  const before = dom.localStorage.getItem("ambra.playlists.v1");
  // Leave long polling pending so this test never schedules retries.
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes("?since=")) return new Promise<Response>(() => {});
    if (init?.method === "POST") writes++;
    return Response.json({ revision: 0, values: { "ambra.playlists.v1": '{"remote":true}' } });
  }) as typeof fetch;
  await hydrateServerState();
  expect(writes).toBe(0);
  expect(getServerItem("ambra.playlists.v1")).toBe('{"remote":true}');
  expect(getPersistentItem("ambra.playlists.v1")).toBe(before);
  setPersistentItem("ambra.queue.v1", '{"localQueue":true}');
  expect(getServerItem("ambra.queue.v1")).toBeNull();
  setServerItem("ambra.playlists.v1", '{"remoteEdit":true}');
  expect(getPersistentItem("ambra.playlists.v1")).toBe(before);
  setServerForTesting("http://another:38147", null);
  expect(getPersistentItem("ambra.playlists.v1")).toBe(before);
  globalThis.fetch = original;
});
test("private device files never enter server queue requests", async () => {
  const { coreChangeQueue } = await import("../src/api/core");
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new TypeError("Offline"); }) as typeof fetch;
  const track = { globalId: "local:private", provider: "local", providerTrackId: "/Music/private.flac", audio: "asset://localhost/Music/private.flac" } as import("../src/types/music").Track;
  await expect(coreChangeQueue(() => [track], state => ({ ...state, current: { track, source: { kind: "library", id: "library", entryId: 1 }, shufflePackageId: null } })))
    .rejects.toThrow("Private device files cannot enter the shared queue");
  expect(requests).toBe(0);
  globalThis.fetch = original;
});
