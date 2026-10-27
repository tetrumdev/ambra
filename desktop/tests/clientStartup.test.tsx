import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const calls: string[] = [];
let paired = false;
let identity = "a".repeat(64);
let bridge = "http://127.0.0.1:9";
const tauriCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({ ...tauriCore, isTauri: () => true, invoke: async (command: string) => {
  calls.push(command);
  if (command === "server_connection") return { mode: paired ? "join" : "host", baseUrl: bridge, token: null, server: paired ? { id: "home", name: "Home", address: "music.local", publicKey: identity } : null, clientId: "test", clientName: "Test" };
  if (command === "network_connection_status") return { state: "Offline", error: "Server unavailable" };
  if (command === "discover_servers") return [{ id: "independent", name: "Independent server", address: "music.local", version: "1" }];
  if (command === "start_pairing") return { address: "ambra://pair/key", requestId: "pending", code: "123456", serverName: "Independent server" };
  return null;
} }));
mock.module("../src/App", () => ({ default: ({ localOnly }: { localOnly: boolean }) => <main>Normal local player {String(localOnly)}</main> }));
mock.module("../src/hooks/AudioSettingsContext", () => ({ AudioSettingsProvider: ({ children }: { children: ReactNode }) => children }));
mock.module("../src/hooks/useStartupWindow", () => ({ useStartupWindow: () => {} }));
const { Root } = await import("../src/Root");
const { ServerSettings } = await import("../src/components/settings/ServerSettings");
const { ClientConnectionContext } = await import("../src/hooks/ClientConnectionContext");
const dom = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
beforeAll(() => {
  Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.fetch = (async () => { throw new TypeError("No server installed"); }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; dom.happyDOM.abort(); });
for (const configured of [false, true]) test(`normal UI opens with ${configured ? "unreachable paired server" : "no server configured"}`, async () => {
  paired = configured;
  const container = document.createElement("div"); const root = createRoot(container);
  await act(async () => { root.render(<Root />); await new Promise(resolve => setTimeout(resolve, 10)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(container.textContent).toContain("Normal local player true");
  expect(container.textContent).not.toContain("Connect to Ambra Server");
  if (configured) expect(container.textContent).toContain("Home disconnected");
  expect(calls.some(command => command.includes("start_local") || command === "import_local_music" || command === "set_shared_output")).toBe(false);
  await act(async () => root.unmount());
});
test("Server settings opens optional setup, discovers external servers and accepts pairing links without hosting controls", async () => {
  paired = false;
  const { connectToServer } = await import("../src/api/serverConnection"); await connectToServer();
  localStorage.setItem("ambra.playlists.v1", "keep local playlists");
  const container = document.createElement("div"); const root = createRoot(container);
  await act(async () => { root.render(<ServerSettings active />); });
  const connect = [...container.querySelectorAll("button")].find(button => button.textContent === "Connect to Ambra Server")!;
  expect(connect).toBeDefined();
  await act(async () => connect.click());
  expect(container.textContent).toContain("Independent server");
  expect(container.textContent).not.toContain("Start server");
  expect(container.textContent).not.toContain("Start a server here");
  expect(container.textContent).not.toContain("Approve");
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Server address or pairing link"]')!;
  await act(async () => {
    input.value = "ambra://pair/key";
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    // Discovery uses the same secure pairing path as manual and pairing-link entry.
    [...container.querySelectorAll("button")].find(button => button.textContent === "Connect")!.click();
  });
  expect(calls).toContain("start_pairing");
  expect(container.textContent).toContain("ambra-server pair approve 123456");
  expect(localStorage.getItem("ambra.playlists.v1")).toBe("keep local playlists");
  await act(async () => root.unmount());
});
test("connected Server tab shows transport and client connection actions", async () => {
  paired = true;
  const { connectToServer } = await import("../src/api/serverConnection"); await connectToServer();
  const container = document.createElement("div"); const root = createRoot(container);
  await act(async () => root.render(<ClientConnectionContext.Provider value={{ connected: true, network: { state: "ConnectedHyperDHT", method: "HyperDHT" }, sharedPlayback: false, setSharedPlayback: async () => {}, reconnect: () => {} }}><ServerSettings active /></ClientConnectionContext.Provider>));
  expect(container.textContent).toContain("HyperDHT");
  expect(container.textContent).toContain("Disconnect");
  expect(container.textContent).toContain("Choose another server");
  expect(container.textContent).not.toContain("Stop server");
  await act(async () => root.unmount());
});

test("cached metadata rebases only onto its verified server while device files remain untouched", async () => {
  const { connectToServer, forDeviceStorage, fromDeviceStorage, serverCacheKey } = await import("../src/api/serverConnection");
  paired = true; identity = "a".repeat(64); bridge = "http://127.0.0.1:44000"; await connectToServer();
  const saved = forDeviceStorage(JSON.stringify({ tracks: [{ globalId: "qobuz:1", audio: `${bridge}/api/song?access_token=secret` }, { globalId: "local:file", audio: "asset://localhost/Music/file.flac" }] }));
  expect(saved).not.toContain("secret");
  const firstKey = serverCacheKey("provider-library");
  bridge = "http://127.0.0.1:45000"; await connectToServer();
  expect(fromDeviceStorage(saved)).toContain(`${bridge}/api/song`);
  identity = "b".repeat(64); await connectToServer();
  expect(fromDeviceStorage(saved)).toContain("http://127.0.0.1:44000/api/song");
  expect(fromDeviceStorage(saved)).not.toContain("http://127.0.0.1:45000/api/song");
  expect(fromDeviceStorage(saved)).toContain("asset://localhost/Music/file.flac");
  expect(serverCacheKey("provider-library")).not.toBe(firstKey);
});
