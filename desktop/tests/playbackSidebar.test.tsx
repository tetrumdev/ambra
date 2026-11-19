import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { TrackLyrics } from "../src/types/lyrics";
import type { QueueItem, Track } from "../src/types/music";
import { queueSnapshot } from "../src/utils/queueStorage";

const dom = new Window({ url: "http://localhost/" });
let fullscreen = false;
let resized: (() => Promise<void>) | undefined;
const tauri = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...tauri,
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset://localhost${path}`,
  invoke: async (name: string) => {
    if (name === "load_cached_music" || name === "scan_music") return [];
    if (name === "native_audio_status") {
      return { currentSource: null, currentTime: 0, duration: 0, isPlaying: false, buffering: false, ended: false, error: null, audioQuality: null };
    }
    return null;
  },
}));
const tauriEvents = await import("@tauri-apps/api/event");
mock.module("@tauri-apps/api/event", () => ({ ...tauriEvents, listen: async () => () => {} }));
const tauriWindow = await import("@tauri-apps/api/window");
mock.module("@tauri-apps/api/window", () => ({
  ...tauriWindow,
  getCurrentWindow: () => ({
    isFullscreen: async () => fullscreen,
    isFocused: async () => false,
    isVisible: async () => true,
    onResized: async (handler: typeof resized) => { resized = handler; return () => { resized = undefined; }; },
    onFocusChanged: async () => () => {},
  }),
}));
const tauriWebview = await import("@tauri-apps/api/webview");
mock.module("@tauri-apps/api/webview", () => ({
  ...tauriWebview, getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
const lyrics: TrackLyrics = {
  status: "lyrics", instrumental: false, sync: "line", hasWordSync: false,
  plainLyrics: "An actual line", language: "en", source: "lrclib", originalFormat: "lrc",
  lines: [{
    text: "An actual line", startMs: 1000, endMs: null, singer: null,
    segments: [{ text: "An actual line", startMs: 1000, endMs: null, granularity: "line", singer: null }],
    words: [], translations: [], romanization: [], backgroundVocals: [], key: null,
  }],
  offsetMs: 0, singers: [], failedProviders: [],
};
const lyricsCache = await import("../src/utils/lyricsCache");
mock.module("../src/utils/lyricsCache", () => ({
  ...lyricsCache, cachedLyrics: () => lyrics, loadLyrics: async () => lyrics, preloadLyrics: async () => {},
}));

beforeAll(() => {
  Object.defineProperty(dom.document, "fonts", { value: { ready: Promise.resolve() } });
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, Image: dom.Image,
    ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver, CustomEvent: dom.CustomEvent,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    CSS: dom.CSS, getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  });
});
afterAll(() => { dom.happyDOM.abort(); });

function song(name: string): Track {
  return {
    globalId: `local:/Music/${name}.flac`, provider: "local", providerTrackId: name, playbackKind: "direct",
    name, artist: "Artist", album: "Album", artists: [], albumArtists: [], durationSeconds: 180,
    audio: `/Music/${name}.flac`, cover: "/ambra.svg", nativeCover: null,
  };
}

function queueSong(track: Track, entryId: number): QueueItem {
  return { track, source: { kind: "library", id: "library", entryId }, shufflePackageId: null };
}

test("the windowed sidebar edits the live queue, displays lyrics and history, and hides in fullscreen", async () => {
  const current = song("Current");
  const next = [song("First"), song("Second"), song("Third")];
  const recent = [song("Older"), song("Latest")];
  localStorage.setItem("ambra.playback.v1", JSON.stringify({ trackId: current.globalId, positionSeconds: 0 }));
  localStorage.setItem("ambra.queue.v1", JSON.stringify(queueSnapshot([], queueSong(current, 0), next.map(queueSong))));
  localStorage.setItem("ambra.listening-history.v1", JSON.stringify({ version: 1, entries: recent.map((track, index) => ({ track, lastPlayedAt: index + 1 })) }));

  const { default: App } = await import("../src/App");
  const viewport = document.createElement("div");
  viewport.className = "appViewport";
  document.body.append(viewport);
  const root = createRoot(viewport);
  const pane = () => viewport.querySelector("#playbackSidebar");
  const click = async (selector: string) => {
    const button = viewport.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
  };
  const press = (key: string, code = key) => act(async () => {
    window.dispatchEvent(new dom.KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
  });
  const upcoming = () => [...viewport.querySelectorAll('[aria-label="Upcoming tracks"] button.playbackSidebarTrack')].map(button => button.getAttribute("aria-label"));
  const savedQueue = () => JSON.parse(localStorage.getItem("ambra.queue.v1")!);

  try {
    await act(async () => root.render(<App localOnly />));
    const main = viewport.querySelector("main.appScreen");
    expect(pane()).toBeNull();
    await click("#queueBtn");
    expect(viewport.querySelector("main.appScreen")).toBe(main);
    expect(pane()?.querySelector('[aria-current="true"]')?.textContent).toContain("Current");
    expect(upcoming()).toEqual(["Play First", "Play Second", "Play Third"]);

    await click('[aria-label="Queue options for Second"]');
    await click('#trackCollectionMenu button:has(> img[src="/play-next.svg"])');
    expect(upcoming()).toEqual(["Play Second", "Play First", "Play Third"]);

    const dragFrom = pane()!.querySelector('[aria-label="Play Third"]')!.parentElement!;
    const dragTo = pane()!.querySelector('[aria-label="Play First"]')!.parentElement!;
    const scroll = pane()!.querySelector(".playbackSidebarScroll")!;
    const hit = document.elementFromPoint;
    document.elementFromPoint = () => dragTo;
    scroll.getBoundingClientRect = () => new dom.DOMRect(20, 0, 280, 450);
    dragFrom.parentElement!.getBoundingClientRect = () => new dom.DOMRect(20, 130, 280, 150);
    dragTo.getBoundingClientRect = () => new dom.DOMRect(20, 180, 280, 50);
    const pointer = (type: string, y: number) => new dom.PointerEvent(type, {
      bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse", pointerId: 1, clientX: 250, clientY: y,
    }) as unknown as PointerEvent;
    try {
      await act(async () => {
        dragFrom.querySelector(".playbackSidebarGrip")!.dispatchEvent(pointer("pointerdown", 250));
        window.dispatchEvent(pointer("pointermove", 190));
        window.dispatchEvent(pointer("pointerup", 190));
      });
    } finally {
      document.elementFromPoint = hit;
    }
    expect(upcoming()).toEqual(["Play Second", "Play Third", "Play First"]);

    await click('[aria-label="Queue options for Third"]');
    await click('#trackCollectionMenu button:has(> img[src="/delete.svg"])');
    expect(upcoming()).toEqual(["Play Second", "Play First"]);
    await click('[aria-label="Play Second"]');
    expect(savedQueue().current.globalTrackId).toBe(next[1].globalId);
    expect(upcoming()).toEqual(["Play First"]);

    await click('.playbackSidebarViews button:nth-child(2)');
    expect(pane()?.querySelector("button.lyricLine")?.textContent).toBe("An actual line");
    await click('.playbackSidebarViews button:nth-child(3)');
    const recentTracks = pane()!.querySelector('[aria-label="Recently played tracks"]');
    const previousPlays = [...recentTracks!.querySelectorAll("button")].map(button => button.getAttribute("aria-label"));
    expect(previousPlays).toEqual(["Play Latest", "Play Older"]);

    await press("f", "KeyF");
    expect(viewport.querySelector('#bottomInfoBar[data-variant="expanded"]')).not.toBeNull();
    expect(pane()).toBeNull();
    await press("f", "KeyF");
    expect(pane()?.querySelector('[aria-pressed="true"]')?.textContent).toBe("Recently played");

    fullscreen = true;
    await act(async () => resized?.());
    expect(pane()).toBeNull();
    await press("q", "KeyQ");
    expect(viewport.querySelector("main#queue")).toBe(main);
    await press("q", "KeyQ");
    fullscreen = false;
    await act(async () => resized?.());
    expect(pane()?.querySelector('[aria-pressed="true"]')?.textContent).toBe("Recently played");
    await click('[aria-label="Close playback sidebar"]');
    expect(pane()).toBeNull();
    await press("q", "KeyQ");
    expect(pane()?.querySelector('[aria-pressed="true"]')?.textContent).toBe("Queue");
    await click(".playbackSidebarTextButton");
    expect(viewport.querySelector("main#queue")).toBe(main);
    await press("q", "KeyQ");
    await click(".playbackSidebarViews button:nth-child(3)");
    await click('[aria-label="Play Latest"]');
    expect(savedQueue().current.globalTrackId).toBe(recent[1].globalId);
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("page history restores scroll positions and clears the page filter across visits", async () => {
  const { default: App } = await import("../src/App");
  const { AudioSettingsProvider } = await import("../src/hooks/AudioSettingsContext");
  const { defaultAudioSettings } = await import("../src/utils/audioSettings");
  const { loadPreferences } = await import("../src/utils/preferences");
  const audio = { native: false, load: async () => defaultAudioSettings(), devices: async () => [], save: async () => {} };
  const viewport = document.createElement("div");
  document.body.append(viewport);
  const root = createRoot(viewport);
  const click = (selector: string) => act(async () => {
    viewport.querySelector<HTMLButtonElement>(selector)!.click();
  });
  const moveHistory = (button: number) => act(async () => {
    window.dispatchEvent(new dom.MouseEvent("mouseup", { button, cancelable: true }) as unknown as MouseEvent);
  });
  const nextFrame = () => act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  const filter = () => viewport.querySelector(".pageFilter");
  const libraryPage = () => viewport.querySelector<HTMLDivElement>(".libraryView")!;
  try {
    await act(async () => root.render(<AudioSettingsProvider api={audio}><App localOnly /></AudioSettingsProvider>));
    await click(".sidebarHomeButton");
    await nextFrame();
    libraryPage().scrollTop = 150;

    await click("#libraryContainer > button.sidebarLibraryButton:not(.sidebarHomeButton)");
    await click(".libraryOverviewCard:last-child");
    await nextFrame();
    expect(libraryPage().querySelector("h1")?.textContent).toContain("Tracks");
    libraryPage().scrollTop = 60;
    await act(async () => {
      window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "/", code: "Slash", cancelable: true }) as unknown as KeyboardEvent);
    });
    expect(filter()).not.toBeNull();

    await moveHistory(3);
    expect(libraryPage().querySelector("h1")?.textContent).toBe("My Library");
    expect(filter()).toBeNull();
    await moveHistory(3);
    expect(libraryPage().classList.contains("homeView")).toBe(true);
    expect(libraryPage().scrollTop).toBe(150);
    await moveHistory(4);
    await moveHistory(4);
    expect(libraryPage().querySelector("h1")?.textContent).toContain("Tracks");
    expect(libraryPage().scrollTop).toBe(60);
    expect(filter()).toBeNull();

    await click(".sidebarSettingsButton");
    const specs = viewport.querySelector<HTMLInputElement>('[aria-label="Show song specs"]')!;
    const previous = specs.checked;
    await act(async () => specs.click());
    expect(loadPreferences().ui.showAudioQuality).toBe(!previous);
    await act(async () => specs.click());
    await click(".settingsBack");
    expect(libraryPage().querySelector("h1")?.textContent).toContain("Tracks");
    expect(libraryPage().scrollTop).toBe(60);
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
  }
});

test("shared playback follows the server's listening history as plays arrive", async () => {
  const { useListeningHistory } = await import("../src/hooks/useListeningHistory");
  const { setServerForTesting } = await import("../src/api/serverConnection");
  const { hydrateServerState, resetServerState } = await import("../src/utils/serverState");
  const key = "ambra.listening-history.v1";
  const saved = localStorage.getItem(key);
  const fromServer = { track: song("Shared play"), lastPlayedAt: 1 };
  let sendPatch!: (data: unknown) => void;
  const originalFetch = globalThis.fetch;
  setServerForTesting("http://shared:38147", null);
  globalThis.fetch = (async (url: URL | RequestInfo) => {
    if (String(url).includes("wait=")) return new Promise<Response>(resolve => {
      sendPatch = data => resolve(Response.json(data));
    });
    return Response.json({ revision: 1, values: { [key]: JSON.stringify({ version: 1, entries: [fromServer] }) } });
  }) as typeof fetch;

  function History() {
    const { entries } = useListeningHistory(true);
    return <div>{entries.map(entry => entry.track.name).join(", ")}</div>;
  }
  const viewport = document.createElement("div");
  const root = createRoot(viewport);
  try {
    await act(async () => root.render(<History />));
    await act(async () => hydrateServerState());
    expect(viewport.textContent).toBe("Shared play");
    await act(async () => {
      sendPatch({ revision: 2, changes: {}, patches: { [key]: { play: { track: song("New shared play"), lastPlayedAt: 2 } } } });
    });
    expect(viewport.textContent).toBe("New shared play, Shared play");
    expect(localStorage.getItem(key)).toBe(saved);
  } finally {
    await act(async () => root.unmount());
    resetServerState();
    globalThis.fetch = originalFetch;
  }
});
