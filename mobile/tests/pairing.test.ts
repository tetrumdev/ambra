import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const tokenKey = "ambra.token";
const payloadKey = "ambra.pairingPayload.v1";
const store = new Map<string, string>();
let holdToken: { started: () => void; release: Promise<void> } | null = null;
let failOpen = false;
const opened: unknown[] = [];
mock.module("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    store.set(key, value);
    if (key === tokenKey && value === "new-token" && holdToken) {
      const hold = holdToken;
      holdToken = null;
      hold.started();
      await hold.release;
    }
  },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));
mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
mock.module("../modules/ambra-network/src", () => ({
  nativeNetworkAvailable: true,
  networkCall: async (_operation: string, args: { payload?: string; token?: string }) => {
    opened.push(args);
    if (failOpen && args.token === "new-token") throw new Error("Bridge unavailable");
    return { baseUrl: "http://phone.test/capability" };
  },
}));
const client = await import("../src/client");
const originalFetch = globalThis.fetch;
const response = (value: unknown) => new Response(JSON.stringify(value));
afterAll(() => { globalThis.fetch = originalFetch; });
beforeEach(async () => {
  store.clear();
  store.set(tokenKey, "old-token");
  store.set(payloadKey, "ambra://pair/original");
  holdToken = null;
  failOpen = false;
  opened.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => response(String(input).endsWith("/request")
    ? { requestId: "new-request", code: "123456" } : { status: "approved", token: "new-token" })) as typeof fetch;
  await client.restore();
  await client.requestPairing("ambra://pair/new-server", "iPhone");
});

test("approved pairing saves the matching server and token", async () => {
  await client.awaitPairing("new-request", new AbortController().signal);
  expect(store.get(tokenKey)).toBe("new-token");
  expect(store.get(payloadKey)).toBe("ambra://pair/new-server");
  expect(opened.at(-1)).toEqual({ payload: "ambra://pair/new-server", token: "new-token" });
});

test("canceling an approval response cannot overwrite the original pairing", async () => {
  let finish!: (value: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as unknown as typeof fetch;
  const abort = new AbortController();
  const pairing = client.awaitPairing("new-request", abort.signal);
  abort.abort();
  finish(response({ status: "approved", token: "new-token" }));
  await expect(pairing).rejects.toMatchObject({ name: "AbortError" });
  expect(store.get(tokenKey)).toBe("old-token");
  expect(store.get(payloadKey)).toBe("ambra://pair/original");
});

test("cancel during storage waits for rollback before restoring the original server", async () => {
  let began!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  holdToken = { started: began, release: new Promise<void>(resolve => { release = resolve; }) };
  const abort = new AbortController();
  const pairing = client.awaitPairing("new-request", abort.signal);
  await started;
  abort.abort();
  const restoring = client.restore();
  release();
  await expect(pairing).rejects.toMatchObject({ name: "AbortError" });
  expect(await restoring).toEqual({ address: "ambra://pair/original", paired: true });
  expect(store.get(tokenKey)).toBe("old-token");
  expect(opened.at(-1)).toEqual({ payload: "ambra://pair/original", token: "old-token" });
});

test("failed bridge activation preserves the previous saved pairing", async () => {
  failOpen = true;
  await expect(client.awaitPairing("new-request", new AbortController().signal)).rejects.toThrow("Bridge unavailable");
  expect(store.get(tokenKey)).toBe("old-token");
  expect(store.get(payloadKey)).toBe("ambra://pair/original");
  expect(await client.restore()).toEqual({ address: "ambra://pair/original", paired: true });
});
