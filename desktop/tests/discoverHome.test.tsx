import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HomeView } from "../src/components/HomeView";
import { updateServiceAvailability } from "../src/hooks/useServiceAvailability";
import type { Track } from "../src/types/music";

const dom = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
let root: Root;
let container: HTMLDivElement;
let discoverCalls = 0;
const actions: [string, Track[], string | undefined][] = [];
const track: Track = { globalId: "local:a", provider: "local", providerTrackId: "a.flac", playbackKind: "direct", audio: "/api/music/local/files/a.flac", cover: "/api/music/local/files/a.jpg", nativeCover: null, name: "Discovery Song", artist: "Discovery Artist", album: "Album", durationSeconds: 180, artists: [], albumArtists: [], version: null, albumVersion: null, albumId: null, trackNumber: null, discNumber: null, releaseDate: null, explicit: false, isrc: null, copyright: null, label: null, genres: [], upc: null, quality: null, maximumSamplingRateKHz: null, maximumBitDepth: null };
let next = { tracks: [track], reasons: {}, status: "ready", generatedAt: 1, refreshAfterMs: null };

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element,
    Node: dom.Node, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  });
  globalThis.fetch = (async (url) => {
    if (String(url).includes("/recommendations/discover")) { discoverCalls++; return Response.json(next); }
    if (String(url).includes("/auth/status")) return Response.json({ tidal: false, qobuz: false, spotify: false });
    throw new Error(`Unexpected URL: ${String(url)}`);
  }) as typeof fetch;
  updateServiceAvailability({ tidal: false, qobuz: false, spotify: false });
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove(); actions.length = 0;
});
afterAll(() => { globalThis.fetch = originalFetch; dom.happyDOM.abort(); });

async function mount() {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => {
    root.render(<HomeView entries={[]} tracks={[]} playlists={[]} error={null}
      onAction={(action, tracks, id) => actions.push([action, tracks, id])} onSelectPlaylist={() => {}}
      registerScrollElement={() => {}} />);
  });
}

test("Discover stays last, renders real track cards, and preserves Home empty states", async () => {
  next = { ...next, tracks: [track], status: "ready" };
  await mount();
  expect([...container.querySelectorAll("h2")].map(element => element.textContent))
    .toEqual(["Recently played", "Your playlists", "Haven’t played in a while", "Discover"]);
  const section = container.querySelector('section[aria-label="Discover"]')!;
  expect(section.textContent).toContain("Discovery Song"); expect(section.textContent).toContain("Discovery Artist");
  expect(section.querySelector("img")).not.toBeNull();
  expect(section.querySelector("button[aria-haspopup=menu]")?.getAttribute("aria-label")).toBe("Options for Discovery Song by Discovery Artist");
});

test("Discover loading and insufficient-history states stay within their row", async () => {
  next = { ...next, tracks: [], status: "loading" };
  await mount();
  expect(container.querySelector('section[aria-label="Discover"]')?.getAttribute("aria-busy")).toBe("true");
  expect(container.textContent).toContain("Finding music for you");
  await act(async () => { root.unmount(); });
  next = { ...next, tracks: [], status: "insufficientHistory" };
  await mount();
  expect(container.textContent).toContain("Listen to some music to discover new favorites.");
  expect(container.querySelectorAll("section").length).toBe(4);
});

test("keyboard menu supports playback, queue, next, standalone and Escape", async () => {
  next = { ...next, tracks: [track], status: "ready" };
  await mount();
  const trigger = container.querySelector<HTMLButtonElement>('section[aria-label="Discover"] button[aria-haspopup=menu]')!;
  for (const [label, action] of [["Play from Here", "play"], ["Add to Queue", "queue"], ["Play Next", "next"], ["Standalone Play", "standalone"]]) {
    await act(async () => { trigger.focus(); trigger.click(); });
    const menu = document.querySelector('[role="menu"]')!;
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    await act(async () => { menu.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as KeyboardEvent); });
    const button = [...menu.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label)!;
    await act(async () => { button.click(); });
    expect(actions.at(-1)?.[0]).toBe(action); expect(actions.at(-1)?.[1][0].globalId).toBe(track.globalId);
    expect(document.activeElement).toBe(trigger);
  }
  await act(async () => { trigger.click(); });
  await act(async () => { document.querySelector('[role="menu"]')!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as KeyboardEvent); });
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

test("rerenders avoid duplicate requests; reconnect refreshes the row", async () => {
  next = { ...next, tracks: [track], status: "ready" };
  await mount(); const initial = discoverCalls;
  await act(async () => { updateServiceAvailability({ tidal: true, qobuz: false, spotify: false }); });
  expect(discoverCalls).toBe(initial + 1);
  await act(async () => { updateServiceAvailability({ tidal: true, qobuz: false, spotify: false }); });
  expect(discoverCalls).toBe(initial + 1);
  expect(container.textContent).toContain("Discovery Song");
});

test("late responses and unmounted requests cannot replace newer discoveries", async () => {
  const serverFetch = globalThis.fetch;
  const pending: { resolve: (value: Response) => void; signal: AbortSignal }[] = [];
  globalThis.fetch = ((url, init) => String(url).includes("/recommendations/discover")
    ? new Promise<Response>(resolve => pending.push({ resolve, signal: init!.signal! }))
    : serverFetch(url, init)) as typeof fetch;
  try {
    updateServiceAvailability({ tidal: false, qobuz: false, spotify: false });
    await mount();
    expect(pending.length).toBe(1);
    await act(async () => { updateServiceAvailability({ tidal: true, qobuz: false, spotify: false }); });
    expect(pending[0].signal.aborted).toBe(true);
    expect(pending.length).toBe(2);
    await act(async () => { pending[1].resolve(Response.json({ ...next, tracks: [{ ...track, name: "New response" }] })); });
    await act(async () => { pending[0].resolve(Response.json({ ...next, tracks: [{ ...track, name: "Stale response" }] })); });
    expect(container.textContent).toContain("New response"); expect(container.textContent).not.toContain("Stale response");
    await act(async () => { updateServiceAvailability({ tidal: false, qobuz: false, spotify: false }); });
    expect(pending.length).toBe(3);
    await act(async () => { root.unmount(); });
    expect(pending[2].signal.aborted).toBe(true);
    await act(async () => { pending[2].resolve(Response.json(next)); });
  } finally { globalThis.fetch = serverFetch; }
});
