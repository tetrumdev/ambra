import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App";
import { playableTrack, type RemoteTrack } from "../src/api/server";
import { HomeView, type RecommendationSource } from "../src/components/HomeView";
import { SearchBar } from "../src/components/SearchBar";
import { updateServiceAvailability } from "../src/hooks/useServiceAvailability";
import type { Playlist, Track } from "../src/types/music";
import { defaultPreferences, savePreferences } from "../src/utils/preferences";
import { PLAYLIST_STORAGE_KEY } from "../src/utils/playlistStorage";
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
    Node: dom.Node, KeyboardEvent: dom.KeyboardEvent, ResizeObserver: dom.ResizeObserver, IntersectionObserver: dom.IntersectionObserver,
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

test("Search service choices show only icons and retain accessible names", async () => {
  const changed: string[] = [];
  await render(<SearchBar query="" provider="all" providers={["spotify", "tidal", "qobuz"]}
    focusRequest={null} onQueryChange={() => {}} onConfirm={() => {}} onProviderChange={provider => changed.push(provider)} />);
  const trigger = container.querySelector<HTMLButtonElement>('.searchProviderControl .dropdownTrigger')!;
  await act(async () => { trigger.click(); });
  const options = [...container.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')];
  expect(options.map(option => [option.textContent, option.getAttribute("aria-label"), option.querySelector("img")?.getAttribute("src")]))
    .toEqual([["", "All services", "/routed-search.svg"], ["", "Spotify", "/spotify.svg"], ["", "Tidal", "/tidal.svg"], ["", "Qobuz", "/qobuz.svg"]]);
  expect(options[0].getAttribute("aria-checked")).toBe("true");
  await act(async () => { options[1].click(); });
  expect(changed).toEqual(["spotify"]);
});

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

test("Home artwork plays the song on a single click without opening playback options", async () => {
  next = { ...next, tracks: [track], status: "ready" };
  await mount();
  const cover = container.querySelector<HTMLButtonElement>('section[aria-label="Discover"] button.homeCardButton')!;
  await act(async () => {
    cover.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }) as unknown as MouseEvent);
  });
  expect(actions.map(([action, tracks, id]) => [action, tracks.map(song => song.globalId), id]))
    .toEqual([["play", [track.globalId], track.globalId]]);
  expect(document.querySelector("#trackPlaybackMenu")).toBeNull();
});

test("combined song menus keep single-click cover playback and open instantly on right-click", async () => {
  next = { ...next, tracks: [track], status: "ready" };
  await mount(true);
  const card = container.querySelector('section[aria-label="Discover"] .homeArtwork')!;
  const menu = () => document.querySelector<HTMLElement>("#trackPlaybackMenu");
  const mouse = (type: string, detail: number, button = 0, clientX = 0, clientY = 0) => act(async () => {
    card.dispatchEvent(new dom.MouseEvent(type, { detail, button, clientX, clientY, bubbles: true, cancelable: true }) as unknown as MouseEvent);
  });
  await mouse("click", 1);
  expect(menu()).toBeNull();
  expect(actions).toHaveLength(1);
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
  await mouse("dblclick", 2);
  expect(menu()).toBeNull();
  expect(actions.map(([action, tracks, id]) => [action, tracks.map(song => song.globalId), id]))
    .toEqual([["play", [track.globalId], track.globalId], ["play", [track.globalId], track.globalId]]);
});

test("Home song cards open the album and reveal the exact track, and each artist opens their own page", async () => {
  const serverFetch = globalThis.fetch;
  const lead = { providerId: "lead", name: "Discovery Artist", imageUrl: null };
  const guest = { providerId: "guest", name: "Guest Artist", imageUrl: null };
  const song: RemoteTrack = {
    id: "tidal:discover-song", provider: "tidal", providerTrackId: "discover-song", title: "Discovery Song",
    version: null, primaryArtist: lead, artists: [lead, guest],
    album: {
      providerId: "discover-album", title: "Discovery Album", version: null, artists: [lead],
      coverUrl: null, releaseDate: null, label: null, genres: [], upc: null,
    },
    durationSeconds: 180, trackNumber: 2, discNumber: 1, explicit: false, isrc: null,
    copyright: null, quality: null, maximumSamplingRateKHz: null, maximumBitDepth: null,
    playback: { kind: "dash", url: "/api/providers/tidal/tracks/discover-song/manifest.mpd" },
  };
  const other = { ...song, id: "tidal:other-song", providerTrackId: "other-song", trackNumber: 1 };
  const recent = { ...song, id: "tidal:recent-song", providerTrackId: "recent-song", trackNumber: 3, title: "Recently played song" };
  const older = { ...song, id: "tidal:older-song", providerTrackId: "older-song", trackNumber: 4, title: "Older song" };
  let finishAlbum!: (value: Response) => void;
  globalThis.fetch = ((url, init) => {
    const path = String(url).split("/api/")[1];
    if (path === "recommendations/discover?limit=12") return Promise.resolve(Response.json({ ...next, status: "ready", tracks: [song] }));
    if (path === "providers/tidal/albums/discover-album/tracks") return new Promise<Response>(resolve => { finishAlbum = resolve; });
    if (path === "providers/tidal/artists/guest") return Promise.resolve(Response.json({
      artist: { id: "tidal:guest", provider: "tidal", name: guest.name, imageUrl: null },
      biography: null, biographySource: null, popularTracks: [song], popularTracksError: null,
    }));
    if (path?.startsWith("providers/tidal/artists/guest/albums?"))
      return Promise.resolve(Response.json({ albums: [], nextOffset: null }));
    return serverFetch(url, init);
  }) as typeof fetch;
  updateServiceAvailability({ tidal: true, qobuz: false, spotify: false });
  const homeButton = (section: string, name: string) => [...container.querySelectorAll<HTMLButtonElement>(`section[aria-label="${section}"] button`)]
    .find(button => button.textContent === name)!;
  const click = (button: HTMLButtonElement) => act(async () => {
    button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }) as unknown as MouseEvent);
  });
  const back = () => click(container.querySelector<HTMLButtonElement>('.pageHistoryControls [aria-label="Back"]')!);
  const historyKey = "ambra.listening-history.v1";
  localStorage.setItem(historyKey, JSON.stringify({ version: 1, entries: [
    { track: playableTrack(recent), lastPlayedAt: Date.now() },
    { track: playableTrack(older), lastPlayedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 },
  ] }));
  localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify({ version: 1, tracks: [playableTrack(song)], playlists: [
    { id: "discovery-playlist", name: "Discovery playlist", trackIds: [song.id] },
  ] }));
  try {
    savePreferences({ ...defaultPreferences, ui: { ...defaultPreferences.ui, reduceMotion: true, songContextMenu: true } });
    await render(<App localOnly />);
    await click(homeButton("Discover", song.title));
    expect(container.querySelector(".albumView h1")?.textContent).toBe(song.album!.title);
    expect(container.querySelector("[data-revealed]")).toBeNull();

    await act(async () => { finishAlbum(Response.json({ tracks: [song, other, recent, older] })); });
    const rows = [...container.querySelectorAll<HTMLElement>(".albumView [data-track-id]")];
    expect(rows.map(row => row.dataset.trackId)).toEqual([other.id, song.id, recent.id, older.id]);
    expect(rows.filter(row => row.dataset.revealed === "true")).toEqual([rows[1]]);
    await act(async () => { rows[1].dispatchEvent(new dom.Event("wheel", { bubbles: true }) as unknown as Event); });
    expect(container.querySelector("[data-revealed]")).toBeNull();

    await back();
    for (const [section, track] of [["Recently played", recent], ["Haven’t played in a while", older], ["Discover", song]] as const) {
      await click(homeButton(section, track.title));
      expect(container.querySelector(".albumView [data-revealed='true']")?.getAttribute("data-track-id")).toBe(track.id);
      await back();
      await click(homeButton(section, guest.name));
      expect(container.querySelector(".artistView h1")?.textContent).toBe(guest.name);
      expect(container.querySelector(`.artistView [data-track-id="${song.id}"]`)).not.toBeNull();
      await back();
    }

    await click(container.querySelector<HTMLButtonElement>('.sidebarPlaylistName[data-tooltip="Discovery playlist"]')!);
    await click(container.querySelector<HTMLButtonElement>(".playlistView .trackTitleText button")!);
    expect(container.querySelector(".albumView [data-revealed='true']")?.getAttribute("data-track-id")).toBe(song.id);
    await click(container.querySelector<HTMLButtonElement>(`.albumView [data-track-id="${other.id}"] .trackTitleText button`)!);
    expect(container.querySelector(".albumView [data-revealed='true']")?.getAttribute("data-track-id")).toBe(other.id);
    await back();
    expect(container.querySelector(".playlistView h1")?.textContent).toBe("Discovery playlist");
  } finally {
    localStorage.removeItem(historyKey);
    localStorage.removeItem(PLAYLIST_STORAGE_KEY);
    globalThis.fetch = serverFetch;
    await act(async () => { updateServiceAvailability({ tidal: false, qobuz: false, spotify: false }); });
  }
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
    const trigger = () => container.querySelector<HTMLButtonElement>('.homeSource button[aria-haspopup="menu"]')!;
    const options = () => [...container.querySelectorAll<HTMLButtonElement>('.homeSource [role="menuitemradio"]')];
    const key = (target: Element, value: string) => act(async () => {
      target.dispatchEvent(new dom.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
    });
    const open = () => act(async () => { trigger().click(); });
    const choose = async (value: string) => {
      await open();
      await act(async () => { options().find(option => option.textContent === value)!.click(); });
      expect(document.activeElement).toBe(trigger());
    };
    const card = (section: string) => container.querySelector<HTMLButtonElement>(`section[aria-label="${section}"] .homeCardButton`)!;
    const navigate = (label: string) => act(async () => {
      container.querySelector<HTMLButtonElement>(`.pageHistoryControls [aria-label="${label}"]`)!.click();
    });
    const ambraCalls = discoverCalls;
    expect(container.querySelector("h1")?.textContent).toBe("Home");
    expect(trigger().textContent).toBe("Ambra");
    await key(trigger(), "ArrowDown");
    expect(options().map(option => option.textContent)).toEqual(["Ambra", "Spotify", "TIDAL", "Qobuz"]);
    expect(document.activeElement).toBe(options()[0]);
    await key(options()[0], "ArrowDown");
    expect(document.activeElement).toBe(options()[1]);
    await key(options()[1], "Escape");
    expect(options()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
    await open();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    // WebKit can blur the focused option without focusing the trigger on a pointer click.
    await act(async () => {
      document.activeElement!.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true }));
    });
    await open();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(calls).toEqual([]);

    await choose("Spotify");
    await choose("TIDAL");
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
    await navigate("Back");
    expect(trigger().textContent).toBe("TIDAL");
    expect(card("Discovery").querySelector(".homeCardTitle")?.textContent).toBe("Daily Discovery");
    await navigate("Forward");
    expect(container.querySelector(".playlistView h1")?.textContent).toBe("Daily Discovery");
    await navigate("Back");

    await choose("Qobuz");
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
    await navigate("Back");
    expect(trigger().textContent).toBe("Qobuz");

    await act(async () => { updateServiceAvailability({ tidal: true, qobuz: false, spotify: false }); });
    expect(trigger().textContent).toBe("Ambra");
    await open();
    expect(options().map(option => option.textContent)).toEqual(["Ambra", "TIDAL"]);
    await act(async () => {
      container.querySelector("h1")!.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }) as unknown as PointerEvent);
    });
    expect(options()).toHaveLength(0);
    expect(container.textContent).toContain("Discovery Song");
    expect(container.textContent).not.toContain("WeeklyQ");
  } finally {
    globalThis.fetch = serverFetch;
    await act(async () => { updateServiceAvailability({ tidal: false, qobuz: false, spotify: false }); });
  }
});

test("daily mix artwork loads independently and uses only the selected provider", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const daylist = "37i9dQZF1EP6YuccBxUcC1";
  let finishQobuz!: (response: Response) => void;
  let qobuzSignal: AbortSignal | null | undefined;
  const opened: unknown[] = [];
  const view = (source: RecommendationSource) => <HomeView entries={[]} tracks={[]} playlists={[]} error={null}
    onAction={() => {}} onSelectPlaylist={() => {}} onOpenEntity={entity => opened.push(entity)}
    selectedSource={source} onSelectSource={() => {}} registerScrollElement={() => {}} />;
  const card = () => container.querySelector<HTMLButtonElement>(".homeCardButton")!;
  globalThis.fetch = ((url, options) => {
    const path = String(url).split("/api/")[1];
    calls.push(path);
    switch (path) {
      case "providers/qobuz/recommendations":
        return Promise.resolve(Response.json({
          mixes: [{ id: "daily-suggestions", title: "Daily suggestions", imageUrl: null, artworkFallback: true }],
          albums: [],
        }));
      case "providers/qobuz/recommendations/daily-suggestions/artwork":
        qobuzSignal = options?.signal;
        return new Promise<Response>(resolve => { finishQobuz = resolve; });
      case "providers/spotify/recommendations":
        return Promise.resolve(Response.json({
          mixes: [{ id: daylist, title: "daylist", imageUrl: null, artworkFallback: true }],
          albums: [],
        }));
      case `providers/spotify/recommendations/${daylist}/artwork`:
        return Promise.resolve(Response.json({ imageUrl: "https://daylist.spotifycdn.com/daylist.jpg" }));
      default:
        throw new Error(`Unexpected URL: ${String(url)}`);
    }
  }) as typeof fetch;
  updateServiceAvailability({ tidal: true, qobuz: true, spotify: true });
  try {
    await render(view("qobuz"));
    expect(card().textContent).toContain("Daily suggestions");
    expect(card().querySelector(".homePlaylistPlaceholder")).not.toBeNull();
    await act(async () => { card().click(); });
    expect(opened[0]).toMatchObject({ kind: "mix", mix: { provider: "qobuz", id: "daily-suggestions" } });

    await act(async () => { finishQobuz(Response.json({
      imageUrl: null, albumImageUrls: ["https://static.qobuz.com/a.jpg", "https://static.qobuz.com/b.jpg"],
    })); });
    expect(card().querySelectorAll(".homeMixArtwork img")).toHaveLength(2);

    await act(async () => { root.render(view("spotify")); });
    expect(qobuzSignal?.aborted).toBe(true);
    expect(card().querySelector(".homeMixArtwork")).toBeNull();
    expect(card().querySelector("img")).not.toBeNull();
    await act(async () => { card().click(); });
    expect(opened[1]).toMatchObject({ kind: "mix", mix: {
      provider: "spotify", id: daylist, imageUrl: "https://daylist.spotifycdn.com/daylist.jpg",
    } });
    expect(calls).toEqual([
      "providers/qobuz/recommendations", "providers/qobuz/recommendations/daily-suggestions/artwork",
      "providers/spotify/recommendations", `providers/spotify/recommendations/${daylist}/artwork`,
    ]);
  } finally {
    globalThis.fetch = original;
    await act(async () => { updateServiceAvailability({ tidal: false, qobuz: false, spotify: false }); });
  }
});
