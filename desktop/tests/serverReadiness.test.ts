import { expect, test } from "bun:test";
import { fetchWhenServerReady } from "../src/utils/serverReadiness";

test("retries a starting sidecar, but returns provider HTTP errors without retrying", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    if (++calls === 1) throw new TypeError("Failed to fetch");
    return new Response("provider unavailable", { status: 503 });
  }) as unknown as typeof fetch;
  try {
    const response = await fetchWhenServerReady("http://127.0.0.1/library");
    expect(response.status).toBe(503);
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = original;
  }
});

test("unmount cancels a pending startup retry", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  try {
    const controller = new AbortController();
    const result = fetchWhenServerReady("http://127.0.0.1/library", controller.signal);
    await Promise.resolve();
    controller.abort(new Error("unmounted"));
    await expect(result).rejects.toThrow("unmounted");
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = original;
  }
});
