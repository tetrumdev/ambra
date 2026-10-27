import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ServiceAuthStatus, StreamingProvider } from "../src/api/server";

const dom = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
const requests: { url: string; body: Record<string, unknown> }[] = [];
const native: { command: string; args?: Record<string, unknown> }[] = [];
let address = "first";
let connected: ServiceAuthStatus = { tidal: false, qobuz: false, spotify: false };
let finish!: (url: string) => void;
let close!: (error: Error) => void;
let ignoreClose = false;
const tauri = { ...await import("@tauri-apps/api/core") };
mock.module("@tauri-apps/api/core", () => ({ ...tauri, isTauri: () => true,
  invoke: async (command: string, args?: Record<string, unknown>) => {
    native.push({ command, args });
    if (command === "server_connection") return {
      mode: "join", baseUrl: `http://${address}:38147`, token: null, fallback: false,
      server: { id: address, name: address, publicKey: address }, clientId: "desktop", clientName: "Desktop",
    };
    if (command === "open_service_login") return new Promise<string>((resolve, reject) => { finish = resolve; close = reject; });
    if (command === "cancel_service_login" && !ignoreClose) close?.(new Error("Sign-in cancelled"));
    return null;
  },
}));
mock.module("../src/components/SpotifyPlaybackSettings", () => ({ SpotifyPlaybackSettings: () => null }));
const { signInService } = await import("../src/utils/serviceSignIn");
const { connectToServer } = await import("../src/api/serverConnection");
const { ServiceSettings } = await import("../src/components/ServiceSettings");
const { ClientConnectionContext } = await import("../src/hooks/ClientConnectionContext");
beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  });
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ url, body });
    if (url.endsWith("/api/auth/status")) return Response.json(connected);
    const provider = url.match(/\/api\/auth\/(tidal|qobuz|spotify)\//)?.[1] as StreamingProvider;
    if (url.endsWith("/start?browser=true")) return Response.json({ status: "callbackRequired", loginUrl: `https://login.example/${provider}`, attemptId: "a".repeat(32) });
    if (url.endsWith("/complete")) { connected[provider] = true; return Response.json({ status: "connected" }); }
    if (url.endsWith("/cancel")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
});
beforeEach(async () => {
  address = "first"; await connectToServer();
  requests.length = 0; native.length = 0; ignoreClose = false;
  connected = { tidal: false, qobuz: false, spotify: false };
});
afterAll(() => { globalThis.fetch = originalFetch; dom.happyDOM.abort(); });
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

for (const provider of ["tidal", "qobuz", "spotify"] as const) {
  test(`${provider} browser redirects complete sign-in automatically on the selected server`, async () => {
    const result = signInService(provider, new AbortController().signal);
    await flush();
    expect(native.find(call => call.command === "open_service_login")?.args).toEqual({
      provider, loginUrl: `https://login.example/${provider}`, attemptId: "a".repeat(32),
    });
    const callback = `http://127.0.0.1/login?code=${provider}-test-code`;
    finish(callback);
    await result;
    expect(requests.find(request => request.url.endsWith("/complete"))).toEqual({
      url: `http://first:38147/api/auth/${provider}/complete`, body: { callbackUrl: callback, attemptId: "a".repeat(32) },
    });
    expect(connected[provider]).toBe(true);
  });
}

test("cancellation closes the browser, clears the pending attempt, and never completes it", async () => {
  const controller = new AbortController();
  const result = signInService("tidal", controller.signal);
  const outcome = result.then(() => null, error => error);
  await flush(); controller.abort();
  expect(await outcome).toBeTruthy();
  expect(native.some(call => call.command === "cancel_service_login")).toBe(true);
  expect(requests.some(request => request.url.endsWith("/cancel"))).toBe(true);
  expect(requests.some(request => request.url.endsWith("/complete"))).toBe(false);
});

test("a late callback after switching servers cannot authorize the newly selected server", async () => {
  ignoreClose = true;
  const result = signInService("qobuz", new AbortController().signal);
  const outcome = result.then(() => null, error => error);
  await flush(); address = "second"; await connectToServer();
  finish("http://127.0.0.1:8788/qobuz?code_autorisation=late-test-code");
  expect(await outcome).toBeTruthy();
  expect(requests.some(request => request.url.endsWith("/complete"))).toBe(false);
  expect(requests.some(request => request.url.includes("second") && request.url.endsWith("/cancel"))).toBe(false);
});

test("Services restores sign-in buttons and refreshes service availability without callback pasting", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onConnected = mock();
  try {
    await act(async () => root.render(<ClientConnectionContext.Provider value={{
      connected: true, sharedPlayback: false, network: { state: "ConnectedLocal" },
      setSharedPlayback: async () => {}, reconnect: () => {},
    }}><ServiceSettings active onServiceConnected={onConnected} /></ClientConnectionContext.Provider>));
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Sign in to Tidal"]')!;
    await act(async () => { button.click(); });
    expect(container.textContent).toContain("Waiting for sign-in");
    expect(container.querySelector("input")).toBeNull();
    const callbacks = onConnected.mock.calls.length;
    await act(async () => { finish("https://tidal.com/android/login/auth?code=test-code"); });
    expect(button.textContent).toBe("Connected");
    expect(button.disabled).toBe(true);
    expect(onConnected.mock.calls.length).toBe(callbacks + 1);
  } finally {
    await act(async () => root.unmount());
  }
});
