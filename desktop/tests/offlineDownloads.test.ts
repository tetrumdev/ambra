import { afterAll, expect, test } from "bun:test";
import { refreshServerDownloads, startDownloads } from "../src/utils/offlineDownloads";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
let scheduled: { run: () => void; delay: number } | undefined;
let fail = false;
let finished = false;

afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

test("background download polling survives failures and keeps discovering jobs while idle", async () => {
  globalThis.fetch = (async () => {
    if (fail) throw new Error("Temporary network failure");
    return Response.json({ entries: [], jobs: [{ id: 1, finished }] });
  }) as typeof fetch;
  globalThis.setTimeout = ((run: () => void, delay: number) => {
    scheduled = { run, delay };
    return 123456;
  }) as unknown as typeof setTimeout;

  startDownloads();
  await refreshServerDownloads();
  expect(scheduled?.delay).toBe(2000);

  fail = true;
  scheduled = undefined;
  await refreshServerDownloads();
  expect(scheduled?.delay).toBe(2000);

  fail = false;
  finished = true;
  scheduled = undefined;
  await refreshServerDownloads();
  expect(scheduled?.delay).toBe(15_000);

  finished = false;
  scheduled!.run();
  await new Promise(resolve => originalSetTimeout(resolve, 0));
  expect(scheduled?.delay).toBe(2000);
});
