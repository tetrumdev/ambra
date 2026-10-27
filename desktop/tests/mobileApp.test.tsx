import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import * as React from "react";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

const host = (name: string) => ({ children, style }: { children?: ReactNode; style?: React.CSSProperties }) => <div data-host={name} style={style}>{children}</div>;
mock.module("../../mobile/node_modules/react", () => React);
mock.module("../../mobile/node_modules/react-native", () => ({ View: host("view") }));
mock.module("../../mobile/node_modules/react-native-gesture-handler", () => ({ GestureHandlerRootView: host("gestures") }));
mock.module("../../mobile/node_modules/react-native-safe-area-context", () => ({ SafeAreaProvider: host("safe-area") }));
mock.module("../../mobile/node_modules/expo-status-bar", () => ({ StatusBar: () => null }));
mock.module("../../mobile/node_modules/expo-font", () => ({ useFonts: () => [true, null] }));
mock.module("../src/assets/fonts/SourceSerif4Variable-Roman.ttf", () => ({ default: 1 }));
mock.module("../src/assets/fonts/StackSansText-VariableFont_wght.ttf", () => ({ default: 2 }));
mock.module("../../mobile/src/theme", () => ({ colors: { black: "#000" } }));
mock.module("../../mobile/src/Player", () => ({ Player: ({ connectionError }: { connectionError: string | null }) => <main data-player data-connection-error={connectionError ?? ""} style={{ flex: 1 }} /> }));
mock.module("../../mobile/src/Pairing", () => ({ Pairing: ({ initialError, onPaired }: { initialError: string | null; onPaired: () => void }) => <button data-pairing data-error={initialError ?? ""} onClick={onPaired}>Pair</button> }));

let audioActive = false;
const followers: AbortSignal[] = [];
let restoreSaved: () => Promise<{ address: string | null; paired: boolean }>;
let network = { state: "ConnectedHyperDHT", error: undefined as string | undefined };
mock.module("../../mobile/src/client", () => ({
  Unpaired: class extends Error {},
  restore: () => restoreSaved(),
  networkStatus: async () => network,
  follow: (signal: AbortSignal) => { followers.push(signal); return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); },
}));
mock.module("../../mobile/src/usePhoneOutput", () => ({ usePhoneOutput: (paired: boolean) => {
  React.useEffect(() => { audioActive = paired; return () => { audioActive = false; }; }, [paired]);
} }));

const { default: App } = await import("../../mobile/App");
const dom = new Window();
const previous = { window: globalThis.window, document: globalThis.document };
beforeAll(() => {
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
});
afterAll(() => { Object.assign(globalThis, previous); dom.happyDOM.abort(); });

test("paired startup goes straight to the original full-height player with no top tabs or independent local player", async () => {
  let resolve!: (value: { address: string; paired: boolean }) => void;
  restoreSaved = () => new Promise(value => { resolve = value; });
  network = { state: "ConnectedHyperDHT", error: undefined };
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<App />));
  expect(container.querySelector("[data-pairing]")).toBeNull();
  expect(container.querySelector("[data-player]")).toBeNull();
  await act(async () => resolve({ address: "ambra://pair/pinned-peer", paired: true }));
  const safeArea = container.querySelector<HTMLDivElement>('[data-host="safe-area"]')!;
  const player = container.querySelector<HTMLElement>("[data-player]")!;
  expect(player.parentElement).toBe(safeArea);
  expect(safeArea.children.length).toBe(1);
  expect(safeArea.style.flex).toBe("1 1 0%");
  expect(container.querySelector('[data-host="gestures"]')?.textContent).toBe("");
  expect(audioActive).toBe(true);
  expect(followers.at(-1)?.aborted).toBe(false);
  await act(async () => root.unmount());
  expect(followers.at(-1)?.aborted).toBe(true);
  expect(audioActive).toBe(false);
});

test("P2P errors stay inside the player without inserting a banner that offsets fullscreen or mini-player geometry", async () => {
  restoreSaved = async () => ({ address: "ambra://pair/pinned-peer", paired: true });
  network = { state: "Offline", error: "Peer unreachable" };
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<App />));
  const player = container.querySelector<HTMLElement>("[data-player]")!;
  expect(player.dataset.connectionError).toBe("Peer unreachable");
  expect(player.parentElement?.children.length).toBe(1);
  expect(container.textContent).not.toContain("Local music");
  expect(container.textContent).not.toContain("Server");
  expect(audioActive).toBe(true);
  await act(async () => root.unmount());
});

test("failed restoration shows pairing, and successful pairing starts the same player and phone output", async () => {
  restoreSaved = async () => { throw new Error("Pairing key unavailable"); };
  network = { state: "ConnectedLocal", error: undefined };
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<App />));
  const pairing = container.querySelector<HTMLButtonElement>("[data-pairing]")!;
  expect(pairing.dataset.error).toContain("Pairing key unavailable");
  expect(audioActive).toBe(false);
  await act(async () => pairing.click());
  expect(container.querySelector<HTMLElement>("[data-player]")?.dataset.connectionError).toBe("");
  expect(audioActive).toBe(true);
  await act(async () => root.unmount());
});
