import { afterAll, expect, mock, test } from "bun:test";

mock.module("expo-secure-store", () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
mock.module("../modules/ambra-network/src", () => ({
  nativeNetworkAvailable: false,
  networkCall: async () => { throw new Error("no native bridge in Expo Go"); },
}));
const client = await import("../src/client");
const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
const KEY = "ab".repeat(32);
const respond = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

function serverAt(host: string, key = KEY) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const address = new URL(String(url));
    asked.push(`${address.host}${address.pathname}`);
    if (address.host !== host) throw new Error("unreachable");
    if (address.pathname === "/api/server/info") return respond({ service: "ambra", publicKey: key });
    return respond({ requestId: "r1", code: "123456" });
  }) as unknown as typeof fetch;
  return asked;
}

test("a pairing link's LAN hints are tried on the server's HTTP port, keeping the matching key", async () => {
  const link = `ambra://pair/${Buffer.from(JSON.stringify({ version: 1, publicKey: KEY, name: "Desk", localAddresses: ["10.0.0.9:38149", "192.168.1.20:38149"] })).toString("base64url")}`;
  const asked = serverAt("192.168.1.20:38147");
  expect(await client.requestPairing(link, "Phone")).toEqual({ requestId: "r1", code: "123456" });
  expect(asked).toContain("192.168.1.20:38147/api/pair/request");
});

test("a typed address gets the default port, and a different server's key is refused", async () => {
  serverAt("192.168.1.20:38147");
  await expect(client.requestPairing("192.168.1.20", "Phone")).resolves.toMatchObject({ code: "123456" });
  const link = `ambra://pair/${Buffer.from(JSON.stringify({ version: 1, publicKey: "cd".repeat(32), name: "Desk", localAddresses: ["192.168.1.20:38149"] })).toString("base64url")}`;
  await expect(client.requestPairing(link, "Phone")).rejects.toThrow("Couldn't find the server");
});
