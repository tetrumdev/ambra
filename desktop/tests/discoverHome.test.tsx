import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App";
import { HomeView, type RecommendationSource } from "../src/components/HomeView";
import { updateServiceAvailability } from "../src/hooks/useServiceAvailability";
import type { Playlist, Track } from "../src/types/music";
import { defaultPreferences, savePreferences } from "../src/utils/preferences";
import { SongContextMenu } from "../src/utils/trackMenu";

const dom = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
let root: Root;
let container: HTMLDivElement;
let discoverCalls = 0;
const actions: [string, Track[], string | undefined][] = [];
const track: Track = { globalId: "local:a", provider: "local", providerTrackId: "a.flac", playbackKind: "direct", audio: "/api/music/local/files/a.flac", cover: "/api/music/local/files/a.jpg", nativeCover: null, name: "Discovery Song", artist: "Discovery Artist", album: "Album", durationSeconds: 180, artists: [], albumArtists: [], version: null, albumVersion: null, albumId: null, trackNumber: null, discNumber: null, releaseDate: null, explicit: false, isrc: null, copyright: null, label: null, genres: [], upc: null, quality: null, maximumSamplingRateKHz: null, maximumBitDepth: null };
let next = { tracks: [track], reasons: {}, status: "ready", generatedAt: 1, refreshAfterMs: null };

beforeAll(() => {
  Object.defineProperty(dom.document, "fonts", { value: { ready: Promise.resolve() } });
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element,
    Node: dom.Node, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
    localStorage: dom.localStorage, MutationObserver: dom.MutationObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
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

async function render(component: ReactNode) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(component); });
}

async function mount(combinedMenu = false, playlists: Playlist[] = []) {
  function Harness() {
    const [source, setSource] = useState<RecommendationSource>("ambra");
    return <SongContextMenu.Provider value={combinedMenu}><HomeView entries={[]} tracks={[]} playlists={playlists} error={null}
      onAction={(action, tracks, id) => actions.push([action, tracks, id])} onSelectPlaylist={() => {}} onOpenEntity={() => {}}
      selectedSource={source} onSelectSource={setSource} registerScrollElement={() => {}} /></SongContextMenu.Provider>;
  }
  await render(<Harness />);
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

test("combined song menu opens instantly on right-click and double-click plays the song card", async () => {
  next = { ...next, tracks: [track], status: "ready" };
  await mount(true);
  const card = container.querySelector('section[aria-label="Discover"] .homeCardTitle')!;
  const menu = () => document.querySelector<HTMLElement>("#trackPlaybackMenu");
  const mouse = (type: string, detail: number, button = 0, clientX = 0, clientY = 0) => act(async () => {
    card.dispatchEvent(new dom.MouseEvent(type, { detail, button, clientX, clientY, bubbles: true, cancelable: true }) as unknown as MouseEvent);
  });
  await mouse("click", 1);
  expect(menu()).toBeNull();
  await mouse("contextmenu", 0, 2, 65, 115);
  expect(menu()?.textContent).toContain("Add to Queue");
  expect(menu()?.style.animation).toBe("none");
  expect([menu()?.style.left, menu()?.style.top]).toEqual(["65px", "115px"]);
  await mouse("contextmenu", 0, 2, 220, 120);
  expect([menu()?.style.left, menu()?.style.top]).toEqual(["220px", "120px"]);
  expect(document.querySelectorAll("#trackMenuBackdrop")).toHaveLength(1);
  await act(async () => document.querySelector<HTMLElement>("#trackMenuBackdrop")!.click());
  await mouse("click", 1);
  await mouse("click", 2);
  expect(actions).toHaveLength(0);
  await mouse("dblclick", 2);
  expect(menu()).toBeNull();
  expect(actions.map(([action, tracks, id]) => [action, tracks.map(song => song.globalId), id]))
    .toEqual([["play", [track.globalId], track.globalId]]);
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

test("Home groups saved playlists by service and preserves their order within each group", async () => {
  await mount(false, [
    { id: "spotify:b", name: "Second in alphabet", trackIds: [], provider: "spotify" },
    { id: "local", name: "Local playlist", trackIds: [] },
    { id: "qobuz:a", name: "Qobuz playlist", trackIds: [], provider: "qobuz" },
    { id: "spotify:a", name: "First in alphabet", trackIds: [], provider: "spotify" },
  ]);
  const names = (section: string) => [...container.querySelectorAll(`section[aria-label="${section}"] .homeCardTitle`)]
    .map(element => element.textContent);
  expect(names("Your playlists")).toEqual(["Local playlist"]);
  expect(names("Spotify playlists")).toEqual(["Second in alphabet", "First in alphabet"]);
  expect(names("Qobuz playlists")).toEqual(["Qobuz playlist"]);
});

test("Provider shelves open mixes as playlists and releases as albums, then return to the same source", async () => {
  const serverFetch = globalThis.fetch;
  const calls: string[] = [];
  const album = { id: "qobuz:album", provider: "qobuz", title: "Qobuz release", artist: "Artist", imageUrl: null, releaseDate: "2026-11-21" };
  const olderAlbum = { ...album, id: "qobuz:older", title: "Older release", releaseDate: "2026-11-20" };
  const mix = (id: string, title: string, section?: string) => ({ id, title, imageUrl: null, section });
  const tidalTrack = {
    id: "tidal:123", provider: "tidal", providerTrackId: "123", title: "TIDAL recommendation",
    primaryArtist: { name: "Artist" }, artists: [], durationSeconds: 180,
    playback: { kind: "dash", url: "/api/providers/tidal/tracks/123/manifest.mpd" },
  };
  let spotifyReply!: (value: Response) => void;
  let spotifySignal: AbortSignal | null | undefined;
  let mixAttempts = 0;
  globalThis.fetch = ((url, init) => {
    const path = String(url).split("/api/")[1];
    if (path === "providers/spotify/recommendations") {
      calls.push(path);
      spotifySignal = init?.signal;
      return new Promise<Response>(resolve => { spotifyReply = resolve; });
    }
    if (path === "providers/tidal/recommendations") {
      calls.push(path);
      return Promise.resolve(Response.json({ mixes: [
        mix("discovery", "Daily Discovery", "Discovery"), mix("daily", "My Mix 1", "Daily mixes"),
      ], albums: [] }));
    }
    if (path === "providers/tidal/recommendations/discovery") {
      calls.push(path);
      if (++mixAttempts === 1) return Promise.resolve(new Response(null, { status: 502 }));
      return Promise.resolve(Response.json([tidalTrack]));
    }
    if (path === "providers/qobuz/recommendations") {
      calls.push(path);
      return Promise.resolve(Response.json({ mixes: [mix("weekly", "WeeklyQ")], albums: [olderAlbum, album] }));
    }
    if (path === "providers/qobuz/albums/album/tracks") {
      calls.push(path);
      return Promise.resolve(Response.json({ tracks: [{
        ...tidalTrack, id: "qobuz:456", provider: "qobuz", providerTrackId: "456", title: "Release song",
        playback: { kind: "direct", url: "/api/providers/qobuz/tracks/456/stream" },
      }] }));
    }
    return serverFetch(url, init);
  }) as typeof fetch;
  updateServiceAvailability({ tidal: true, qobuz: true, spotify: true });
  next = { ...next, tracks: [track], status: "ready" };
  try {
    savePreferences({ ...defaultPreferences, ui: { ...defaultPreferences.ui, reduceMotion: true } });
    await render(<App localOnly />);
    const select = () => container.querySelector<HTMLSelectElement>('select[aria-label="Recommendation source"]')!;
    const choose = (value: string) => act(async () => {
      select().value = value;
      select().dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
    });
    const card = (section: string) => container.querySelector<HTMLButtonElement>(`section[aria-label="${section}"] .homeCardButton`)!;
    const back = () => act(async () => { container.querySelector<HTMLButtonElement>(".browseBack")!.click(); });
    const ambraCalls = discoverCalls;
    expect(container.querySelector("h1")?.textContent).toBe("Home");
    expect(select().value).toBe("ambra");
    expect([...select().options].map(option => option.text)).toEqual(["Ambra", "Spotify", "TIDAL", "Qobuz"]);
    expect(calls).toEqual([]);

    await choose("spotify");
    await choose("tidal");
    expect(spotifySignal?.aborted).toBe(true);
    await act(async () => { spotifyReply(Response.json({ mixes: [mix("daylist", "daylist")], albums: [] })); });
    expect(container.textContent).not.toContain("daylist");
    expect(container.textContent).not.toContain("Discovery Song");
    expect(container.textContent).toContain("Daily Discovery");
    expect(calls).toEqual(["providers/spotify/recommendations", "providers/tidal/recommendations"]);

    expect(card("Daily mixes").querySelector(".homeCardTitle")?.textContent).toBe("My Mix 1");
    await act(async () => { card("Discovery").click(); });
    expect(calls.at(-1)).toEqual("providers/tidal/recommendations/discovery");
    const mixPage = container.querySelector(".playlistView")!;
    expect(mixPage.querySelector("h1")?.textContent).toBe("Daily Discovery");
    const retry = mixPage.querySelector<HTMLButtonElement>('[role="alert"] button')!;
    await act(async () => { retry.click(); });
    expect(mixPage.textContent).toContain("TIDAL recommendation");
    expect(mixPage.querySelector<HTMLButtonElement>(".libraryPlayBtn")?.disabled).toBe(false);
    expect(mixPage.querySelector<HTMLButtonElement>(".libraryShuffleBtn")?.disabled).toBe(false);
    await back();
    expect(select().value).toBe("tidal");
    expect(card("Discovery").querySelector(".homeCardTitle")?.textContent).toBe("Daily Discovery");

    await choose("qobuz");
    expect(container.textContent).toContain("WeeklyQ");
    expect(container.textContent).toContain("Qobuz release");
    expect(container.textContent).not.toContain("TIDAL recommendation");
    expect(discoverCalls).toBe(ambraCalls);
    expect([...container.querySelectorAll('section[aria-label="Release Watch"] .homeCardTitle')]
      .map(element => element.textContent)).toEqual(["Qobuz release", "Older release"]);
    await act(async () => { card("Release Watch").click(); });
    expect(calls.at(-1)).toBe("providers/qobuz/albums/album/tracks");
    expect(container.querySelector(".albumView h1")?.textContent).toBe("Qobuz release");
    expect(container.querySelector(".albumView")?.textContent).toContain("Release song");
    await back();
    expect(select().value).toBe("qobuz");

    await act(async () => { updateServiceAvailability({ tidal: true, qobuz: false, spotify: false }); });
    expect([...select().options].map(option => option.text)).toEqual(["Ambra", "TIDAL"]);
    expect(select().value).toBe("ambra");
    expect(container.textContent).toContain("Discovery Song");
    expect(container.textContent).not.toContain("WeeklyQ");
  } finally {
    globalThis.fetch = serverFetch;
    await act(async () => { updateServiceAvailability({ tidal: false, qobuz: false, spotify: false }); });
  }
});
