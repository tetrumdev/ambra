import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useContext, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const calls: string[] = [];
let paired = false;
let identity = "a".repeat(64);
let bridge = "http://127.0.0.1:9";
let targetBridge = bridge;
let targetIdentity = identity;
let networkState = "Offline";
let pairingStatus = "pending";
let commandFailure: string | null = null;
let showSettings = false;
let mounts = 0;
const tauriCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({ ...tauriCore, isTauri: () => true, invoke: async (command: string) => {
  calls.push(command);
  if (command === "server_connection") return { mode: paired ? "join" : "host", baseUrl: bridge, token: null, server: paired ? { id: "home", name: "Home", address: "music.local", publicKey: identity } : null, clientId: "test", clientName: "Test" };
  if (command === commandFailure) throw new Error("Connection failed safely");
  if (command === "network_connection_status") return { state: networkState, error: networkState === "Offline" ? "Server unavailable" : null };
  if (command === "poll_pairing") return pairingStatus;
  if (command === "join_server") { paired = true; bridge = targetBridge; identity = targetIdentity; }
  if (command === "leave_server") { paired = false; bridge = "http://127.0.0.1:9"; }
  if (command === "discover_servers") return [{ id: "independent", name: "Independent server", address: "music.local", version: "1" }];
  if (command === "start_pairing") return { address: "ambra://pair/key", requestId: "pending", code: "123456", serverName: "Independent server" };
  return null;
} }));
mock.module("../src/App", () => ({ default: ({ localOnly }: { localOnly: boolean }) => {
  const [instance] = useState(() => ++mounts);
  const { reconnect } = useContext(ClientConnectionContext);
  return <main data-instance={instance}>Normal local player {String(localOnly)}
    <button onClick={reconnect}>Refresh network</button>
    <input aria-label="Retained navigation state" defaultValue="local state" />
    {showSettings && <ServerSettings active />}
  </main>;
} }));
mock.module("../src/hooks/AudioSettingsContext", () => ({ AudioSettingsProvider: ({ children }: { children: ReactNode }) => children }));
mock.module("../src/hooks/useStartupWindow", () => ({ useStartupWindow: () => {} }));
const { Root } = await import("../src/Root");
const { ServerSettings } = await import("../src/components/settings/ServerSettings");
const { ClientConnectionContext } = await import("../src/hooks/ClientConnectionContext");
const dom = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
beforeAll(() => {
  Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
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
  const connectionType = container.querySelector<HTMLInputElement>('input[aria-label="Connection type"]')!;
  expect(connectionType.value).toBe("Local");
  expect(connectionType.readOnly).toBe(true);
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
test("Server tab updates its read-only connection type and keeps client connection actions", async () => {
  paired = true;
  const { connectToServer } = await import("../src/api/serverConnection"); await connectToServer();
  const container = document.createElement("div"); const root = createRoot(container);
  for (const [connected, state, method, expected] of [
    [true, "ConnectedLocal", "Lan", "Local network"],
    [true, "ConnectedPwnat", "Pwnat", "pwnat"],
    [true, "ConnectedHyperDHT", "HyperDHT", "HyperDHT"],
    [false, "Reconnecting", "HyperDHT", "Offline"],
    [false, "ConnectingPwnat", "Pwnat", "Offline"],
    [false, "Offline", null, "Offline"],
  ] as const) {
    await act(async () => root.render(<ClientConnectionContext.Provider value={{ connected, network: { state, method }, sharedPlayback: false, setSharedPlayback: async () => {}, reconnect: () => {} }}><ServerSettings active /></ClientConnectionContext.Provider>));
    const connectionType = container.querySelector<HTMLInputElement>('input[aria-label="Connection type"]')!;
    expect(connectionType.value).toBe(expected);
    expect(connectionType.readOnly).toBe(true);
    expect(connectionType.disabled).toBe(false);
  }
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


test("runtime pairing, server switching, disconnect and failure keep the same application mounted", async () => {
  paired = false; bridge = "http://127.0.0.1:9"; showSettings = true;
  pairingStatus = "approved"; networkState = "ConnectedLocal";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url) => {
    if (String(url).includes("?since=")) return new Promise<Response>(() => {});
    return Response.json({ revision: 0, values: {} });
  }) as typeof fetch;
  const container = document.createElement("div"); const root = createRoot(container);
  const click = async (text: string) => {
    const button = [...container.querySelectorAll("button")].find(button => button.textContent === text);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  try {
    await act(async () => { root.render(<Root />); });
    const main = container.querySelector("main")!;
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Retained navigation state"]')!;
    input.value = "keep open settings and navigation";
    const initialMounts = mounts;
    const callStart = calls.length;
    for (const [index, action] of ["Connect to Ambra Server", "Choose another server", "Connect to Ambra Server"].entries()) {
      targetIdentity = String(index + 1).repeat(64); targetBridge = `http://127.0.0.1:${46000 + index}`;
      await click(action);
      await click("Connect");
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1550)); });
      expect(container.textContent).toContain("Normal local player false");
      expect(container.textContent).toContain("Disconnect");
      expect(container.querySelector("main") === main).toBe(true);
      expect(input.value).toBe("keep open settings and navigation");
      expect(mounts).toBe(initialMounts);
      if (index === 0) {
        commandFailure = "leave_server";
        await click("Disconnect");
        expect(container.textContent).toContain("Connection failed safely");
        expect(container.querySelector("main") === main).toBe(true);
        expect(paired).toBe(true);
        commandFailure = null;
      }
      if (index > 0) {
        await click("Disconnect");
        expect(container.textContent).toContain("Normal local player true");
        expect(container.textContent).toContain("No server connected");
      }
    }
    commandFailure = "start_pairing";
    await click("Connect to Ambra Server"); await click("Connect");
    expect(container.textContent).toContain("Connection failed safely");
    expect(container.querySelector("main") === main).toBe(true);
    const changes = calls.slice(callStart);
    expect(changes).toContain("join_server"); expect(changes).toContain("leave_server");
    expect(changes).not.toContain("restart_app");
    expect(changes).not.toContain("pause_native_audio");
    expect(changes).not.toContain("set_shared_output");
  } finally {
    await act(async () => root.unmount());
    showSettings = false; commandFailure = null; networkState = "Offline";
    globalThis.fetch = previousFetch;
  }
});

test("late hydration from the old server cannot replace the new server state", async () => {
  const { connectToServer } = await import("../src/api/serverConnection");
  const { hydrateServerState, getServerItem, resetServerState } = await import("../src/utils/serverState");
  const previousFetch = globalThis.fetch;
  let finishOld!: (value: Response) => void;
  paired = true; bridge = "http://127.0.0.1:47000"; await connectToServer();
  globalThis.fetch = (() => new Promise<Response>(resolve => { finishOld = resolve; })) as typeof fetch;
  const old = hydrateServerState().catch(() => {});
  bridge = "http://127.0.0.1:48000"; identity = "c".repeat(64); await connectToServer();
  globalThis.fetch = (async url => String(url).includes("?since=") ? new Promise<Response>(() => {})
    : Response.json({ revision: 1, values: { "ambra.playlists.v1": "new server" } })) as typeof fetch;
  await hydrateServerState();
  finishOld(Response.json({ revision: 99, values: { "ambra.playlists.v1": "old server" } }));
  await old;
  expect(getServerItem("ambra.playlists.v1")).toBe("new server");
  resetServerState(); globalThis.fetch = previousFetch;
});


test("failed shared saves prevent selection changes and keep edits for retry", async () => {
  const { setServerItem, getServerItem, serverStateStatus } = await import("../src/utils/serverState");
  const previousFetch = globalThis.fetch;
  let failSave = true;
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes("?since=")) return new Promise<Response>(() => {});
    if (init?.method === "POST") {
      if (failSave) throw new TypeError("Offline");
      return Response.json({ revision: 1 });
    }
    return Response.json({ revision: 0, values: {} });
  }) as typeof fetch;
  paired = true; identity = "d".repeat(64); bridge = "http://127.0.0.1:49000";
  networkState = "ConnectedLocal"; showSettings = true;
  const container = document.createElement("div"); const root = createRoot(container);
  try {
    await act(async () => { root.render(<Root />); });
    expect(serverStateStatus().ready).toBe(true);
    await act(async () => setServerItem("ambra.playlists.v1", "unsaved shared edits"));
    const previousLeaves = calls.filter(command => command === "leave_server").length;
    const disconnect = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Disconnect")!;
    await act(async () => disconnect().click());
    expect(paired).toBe(true);
    expect(calls.filter(command => command === "leave_server")).toHaveLength(previousLeaves);
    expect(getServerItem("ambra.playlists.v1")).toBe("unsaved shared edits");
    expect(serverStateStatus().pending).toBe(true);
    failSave = false;
    await act(async () => disconnect().click());
    expect(paired).toBe(false);
    expect(serverStateStatus().pending).toBe(false);
    expect(container.textContent).toContain("Normal local player true");
  } finally {
    await act(async () => root.unmount()); showSettings = false; networkState = "Offline";
    globalThis.fetch = previousFetch;
  }
});

test("old shared commands and queued controls cannot affect a newly selected server", async () => {
  const { connectToServer } = await import("../src/api/serverConnection");
  const { coreCommand, coreView, followCore } = await import("../src/api/core");
  const previousFetch = globalThis.fetch;
  paired = true; bridge = "http://127.0.0.1:50000"; await connectToServer();
  let finish!: (response: Response) => void;
  const sent: string[] = [];
  globalThis.fetch = ((url) => {
    sent.push(String(url));
    return new Promise<Response>(resolve => { finish = resolve; });
  }) as typeof fetch;
  try {
    const old = coreCommand("play").catch(error => error);
    const queued = coreCommand("pause").catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
    bridge = "http://127.0.0.1:51000"; identity = "e".repeat(64); await connectToServer();
    const session = { instanceId: "server", revision: 1, queueRevision: 1, queue: { tracks: [], history: [], current: null, upcoming: [] } };
    finish(Response.json(session));
    await old; await queued;
    expect(sent).toHaveLength(1);
    expect(coreView()).toBeNull();
    globalThis.fetch = (async url => { sent.push(String(url)); return Response.json(session); }) as typeof fetch;
    await coreCommand("play");
    expect(sent.at(-1)).toStartWith(bridge);
    expect(coreView()?.instanceId).toBe("server");
    // Releasing shared playback cancels both the core poll and clock sampling.
    const signals: AbortSignal[] = [];
    globalThis.fetch = ((_url, init) => { signals.push(init!.signal!); return new Promise<Response>(() => {}); }) as typeof fetch;
    const stop = followCore();
    expect(signals.length).toBeGreaterThan(0);
    stop();
    expect(signals.every(signal => signal.aborted)).toBe(true);
  } finally { globalThis.fetch = previousFetch; }
});

test("switching servers from shared playback commits pairing before releasing the shared UI", async () => {
  const previousFetch = globalThis.fetch;
  paired = true; identity = "f".repeat(64); bridge = "http://127.0.0.1:52000";
  targetIdentity = "9".repeat(64); targetBridge = "http://127.0.0.1:53000";
  pairingStatus = "approved"; networkState = "ConnectedLocal"; showSettings = true;
  globalThis.fetch = (async url => String(url).includes("?since=") ? new Promise<Response>(() => {})
    : Response.json({ revision: 0, values: {} })) as typeof fetch;
  const container = document.createElement("div"); const root = createRoot(container);
  try {
    await act(async () => { root.render(<Root />); });
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Shared playback session"]')!.click());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Shared playback session"]')!.checked).toBe(true);
    const started = calls.length;
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Choose another server")!.click());
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Connect")!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1550)); });
    const switched = calls.slice(started);
    expect(switched.indexOf("join_server")).toBeGreaterThanOrEqual(0);
    expect(switched.indexOf("join_server")).toBeLessThan(switched.indexOf("set_shared_output"));
    expect(switched.indexOf("join_server")).toBeLessThan(switched.indexOf("cancel_pairing"));
    // Read the live module export after the transition.
    expect((await import("../src/api/serverConnection")).serverConnection?.baseUrl).toBe(targetBridge);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Shared playback session"]')!.checked).toBe(false);
    expect(switched).not.toContain("restart_app");
  } finally {
    await act(async () => root.unmount()); showSettings = false; networkState = "Offline";
    globalThis.fetch = previousFetch;
  }
});

test("shared playback retains its owner through bounded reconnect and releases after failure", async () => {
  paired = true; identity = "7".repeat(64); bridge = "http://127.0.0.1:54000";
  networkState = "ConnectedHyperDHT";
  const preference = localStorage.getItem("ambra.shared-playback.v1");
  localStorage.setItem("ambra.shared-playback.v1", "true");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async url => String(url).includes("?since=") ? new Promise<Response>(() => {})
    : Response.json({ revision: 0, values: {} })) as typeof fetch;
  const container = document.createElement("div"); const root = createRoot(container);
  try {
    await act(async () => { root.render(<Root />); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const main = container.querySelector("main");
    const started = calls.length;
    for (const state of ["Reconnecting", "ConnectingHyperDHT", "Authenticating", "ConnectedHyperDHT"]) {
      networkState = state;
      await act(async () => container.querySelector<HTMLButtonElement>("main button")!.click());
      expect(container.querySelector("main") === main).toBe(true);
      expect(calls.slice(started)).not.toContain("pause_native_audio");
      expect(calls.slice(started)).not.toContain("set_shared_output");
    }
    networkState = "Offline";
    await act(async () => container.querySelector<HTMLButtonElement>("main button")!.click());
    expect(calls.slice(started)).toContain("pause_native_audio");
    expect(container.querySelector("main") === main).toBe(false);
    expect(container.textContent).toContain("Normal local player true");
  } finally {
    await act(async () => root.unmount());networkState = "Offline";globalThis.fetch = previousFetch;
    if (preference === null) localStorage.removeItem("ambra.shared-playback.v1");else localStorage.setItem("ambra.shared-playback.v1",preference);
  }
});

test("shared playback can be turned off during reconnect without restarting on recovery", async () => {
  paired = true; identity = "8".repeat(64); bridge = "http://127.0.0.1:55000";
  networkState = "ConnectedHyperDHT";showSettings = true;
  const preference = localStorage.getItem("ambra.shared-playback.v1");
  localStorage.setItem("ambra.shared-playback.v1", "true");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async url => String(url).includes("?since=") ? new Promise<Response>(() => {})
    : Response.json({ revision: 0, values: {} })) as typeof fetch;
  const container = document.createElement("div");const root = createRoot(container);
  try {
    await act(async () => { root.render(<Root />); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve,0)); });
    networkState = "Reconnecting";
    await act(async () => container.querySelector<HTMLButtonElement>("main button")!.click());
    const toggle = () => container.querySelector<HTMLInputElement>('input[aria-label="Shared playback session"]')!;
    expect(toggle().checked).toBe(true);expect(toggle().disabled).toBe(false);
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(false);
    const local = container.querySelector("main");
    networkState = "ConnectedHyperDHT";
    await act(async () => container.querySelector<HTMLButtonElement>("main button")!.click());
    expect(toggle().checked).toBe(false);
    expect(container.querySelector("main") === local).toBe(true);
  } finally {
    await act(async () => root.unmount());networkState = "Offline";showSettings = false;globalThis.fetch = previousFetch;
    if (preference === null) localStorage.removeItem("ambra.shared-playback.v1");else localStorage.setItem("ambra.shared-playback.v1",preference);
  }
});
