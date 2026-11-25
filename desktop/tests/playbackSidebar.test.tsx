import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { TrackLyrics } from "../src/types/lyrics";
import type { QueueItem, Track } from "../src/types/music";
import { parsePlaylistSnapshot, PLAYLIST_STORAGE_KEY } from "../src/utils/playlistStorage";
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

test("the sidebar edits the live queue, displays lyrics and history, and restores the queue after the player", async () => {
  const current = song("Current");
  const next = [song("First"), song("Second"), song("Third"), song("Fourth")];
  const recent = [song("Older"), song("Latest")];
  localStorage.setItem("ambra.playback.v1", JSON.stringify({ trackId: current.globalId, positionSeconds: 0 }));
  localStorage.setItem("ambra.queue.v1", JSON.stringify(queueSnapshot([], queueSong(current, 0), next.map(queueSong))));
  localStorage.setItem("ambra.listening-history.v1", JSON.stringify({ version: 1, entries: recent.map((track, index) => ({ track, lastPlayedAt: index + 1 })) }));
  localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify({
    version: 1, tracks: [], playlists: [
      { id: "sidebar-song", name: "Sidebar song", trackIds: [] },
      { id: "sidebar-history", name: "Sidebar history", trackIds: [] },
    ],
  }));

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
  const trackPlays = (label: string) => [...viewport.querySelectorAll(`[aria-label="${label}"] .trackPlayButton`)]
    .map(button => button.getAttribute("aria-label"));
  const upcoming = () => trackPlays("Upcoming songs");
  const menu = () => viewport.querySelector("#trackMenuBackdrop");
  const menuAction = async (label: string) => {
    const button = [...menu()!.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  const savedPlaylist = (id: string) => parsePlaylistSnapshot(localStorage.getItem(PLAYLIST_STORAGE_KEY))
    .playlists.find(playlist => playlist.id === id)?.trackIds;
  const savedQueue = () => JSON.parse(localStorage.getItem("ambra.queue.v1")!);

  try {
    await act(async () => root.render(<App localOnly />));
    const main = viewport.querySelector("main.appScreen");
    expect(pane()).toBeNull();
    await click("#queueBtn");
    expect(viewport.querySelector("main.appScreen")).toBe(main);
    expect(pane()?.querySelector('[aria-current="true"]')?.textContent).toContain("Current");
    expect(upcoming()).toEqual(["Play First", "Play Second", "Play Third", "Play Fourth"]);
    expect(pane()?.querySelector('[aria-current="true"] .trackPlayButton')).not.toBeNull();

    await click('[aria-label="Upcoming songs"] .trackTitleText.entityLink');
    expect(viewport.querySelector(".albumView h1")?.textContent).toBe("Album");
    expect(menu()).toBeNull();
    await click('.pageHistoryControls [aria-label="Back"]');

    await click('[aria-label="Actions for Second"].trackCollectionMenuTrigger');
    expect(menu()?.textContent).toContain("Credits");
    expect(menu()?.textContent).not.toContain("Move to Front");
    await menuAction("Add to Playlist");
    await menuAction("Sidebar song");
    expect(savedPlaylist("sidebar-song")).toEqual([next[1].globalId]);

    await click('[aria-label="Upcoming songs"] .libraryItem:has([aria-label="Play Second"]) .trackName');
    expect(menu()?.textContent).toContain("Play from Here");
    await menuAction("Move to Front");
    expect(upcoming()).toEqual(["Play Second", "Play First", "Play Third", "Play Fourth"]);

    const row = (name: string) => pane()!.querySelector(`[aria-label="Play ${name}"]`)!.closest(".libraryItem")!;
    const dragFrom = row("Third");
    const dragTo = row("First");
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
        dragFrom.querySelector("[data-playback-menu-trigger]")!.dispatchEvent(pointer("pointerdown", 250));
        window.dispatchEvent(pointer("pointermove", 190));
        window.dispatchEvent(pointer("pointerup", 190));
      });
    } finally {
      document.elementFromPoint = hit;
    }
    expect(upcoming()).toEqual(["Play Second", "Play Third", "Play First", "Play Fourth"]);

    await act(async () => {
      row("Third").dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as MouseEvent);
    });
    await act(async () => {
      row("First").dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }) as unknown as MouseEvent);
    });
    expect(pane()?.querySelectorAll('.libraryItem[data-selected="true"]')).toHaveLength(2);
    expect(pane()?.querySelector('[aria-label="Deselect Third"]')?.getAttribute("aria-pressed")).toBe("true");
    await click(".playbackSidebarSelection .selectionRemoveAction");
    expect(upcoming()).toEqual(["Play Second", "Play Fourth"]);
    await click('[aria-label="Play Second"]');
    expect(savedQueue().current.globalTrackId).toBe(next[1].globalId);
    expect(upcoming()).toEqual(["Play Fourth"]);

    await click('.playbackSidebarTabs button:nth-child(2)');
    expect(pane()?.querySelector("button.lyricLine")?.textContent).toBe("An actual line");
    await click('.playbackSidebarTabs button:nth-child(1)');
    await click(".playbackSidebarHistoryToggle");
    expect(trackPlays("Played songs")).toEqual(expect.arrayContaining(["Play Older", "Play Latest"]));
    const latestRow = '[aria-label="Played songs"] .libraryItem:has([aria-label="Play Latest"])';
    await click(`${latestRow} .trackName`);
    expect(menu()?.textContent).toContain("Standalone Play");
    expect(menu()?.textContent).toContain("Add to Queue");
    await menuAction("Play Next");
    expect(upcoming()).toEqual(["Play Latest", "Play Fourth"]);
    await act(async () => {
      pane()!.querySelector(latestRow)!
        .dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as MouseEvent);
    });
    await click('[aria-label="Played songs"] [aria-label="Select Older"]');
    expect(pane()?.querySelectorAll('.libraryItem[data-selected="true"]')).toHaveLength(2);
    await click(".playbackSidebarSelection button:nth-child(2)");
    await menuAction("Sidebar history");
    expect(savedPlaylist("sidebar-history")?.toSorted()).toEqual(recent.map(track => track.globalId).toSorted());
    await press("Escape");
    expect(pane()?.querySelector(".playbackSidebarSelection")).toBeNull();

    await press("f", "KeyF");
    expect(viewport.querySelector('#bottomInfoBar[data-variant="expanded"]')).not.toBeNull();
    expect(viewport.querySelector('.pageHistoryControls[data-player] [aria-label="Forward"]')).not.toBeNull();
    await click('.pageHistoryControls[data-player] [aria-label="Back"]');
    expect(viewport.querySelector("main.appScreen")).toBe(main);
    expect(pane()?.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Queue");
    await click('[aria-label="Close playback sidebar"]');
    expect(pane()).toBeNull();
    await press("q", "KeyQ");
    expect(pane()?.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Queue");
    await click(".playbackSidebarHistoryToggle");
    await click(`${latestRow} .coverImgContainer`);
    expect(savedQueue().current.globalTrackId).toBe(recent[1].globalId);

    await click("#songName");
    expect(viewport.querySelector(".albumView h1")?.textContent).toBe("Album");
    expect(savedQueue().current.globalTrackId).toBe(recent[1].globalId);
    await click('.pageHistoryControls [aria-label="Back"]');
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
    localStorage.removeItem(PLAYLIST_STORAGE_KEY);
  }
});

test("the sidebar divider clamps drag and keyboard resizing and restores the chosen width", async () => {
  const { default: App } = await import("../src/App");
  const viewport = document.createElement("div");
  viewport.className = "appViewport";
  document.body.append(viewport);
  const root = createRoot(viewport);
  const previousWindowWidth = dom.innerWidth;
  const setWindowWidth = (width: number) => act(async () => dom.happyDOM.setViewport({ width }));
  const toggle = () => act(async () => viewport.querySelector<HTMLButtonElement>("#queueBtn")!.click());
  const divider = () => viewport.querySelector<HTMLElement>('[role="separator"][aria-controls="playbackSidebar"]')!;
  const width = () => viewport.style.getPropertyValue("--playback-sidebar-width");
  const press = (key: string, shiftKey = false) => act(async () => {
    divider().dispatchEvent(new dom.KeyboardEvent("keydown", { key, code: key, shiftKey, bubbles: true, cancelable: true }) as unknown as KeyboardEvent);
  });
  const pointer = (type: string, clientX: number) => {
    divider().dispatchEvent(new dom.PointerEvent(type, {
      clientX, bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse", pointerId: 1,
    }) as unknown as PointerEvent);
  };

  try {
    // The sidebar's open state and width are remembered; start from neither.
    localStorage.removeItem("ambra.device-view.v1");
    await setWindowWidth(1200);
    await act(async () => root.render(<App localOnly />));
    await toggle();
    divider().focus();
    await press("Home");
    await press("ArrowRight");
    expect(width()).toBe("320px");
    await press("ArrowLeft", true);
    expect(width()).toBe("360px");
    expect(divider().getAttribute("aria-valuenow")).toBe("360");

    await act(async () => {
      pointer("pointerdown", 840);
      pointer("pointermove", 1200);
    });
    expect(width()).toBe("320px");
    await act(async () => pointer("pointermove", 550));
    expect(width()).toBe("520px");
    await act(async () => pointer("lostpointercapture", 550));
    await act(async () => pointer("pointermove", 840));
    expect(width()).toBe("520px");

    await setWindowWidth(850);
    expect(width()).toBe("350px");
    expect(divider().getAttribute("aria-valuemax")).toBe("350");
    await toggle();
    expect(width()).toBe("");
    await setWindowWidth(1200);
    await toggle();
    expect(width()).toBe("520px");
  } finally {
    await act(async () => root.unmount());
    await setWindowWidth(previousWindowWidth);
    viewport.remove();
  }
});

test("Combined song menus open from the dots without starting playback", async () => {
  const { default: App } = await import("../src/App");
  const { AudioSettingsProvider } = await import("../src/hooks/AudioSettingsContext");
  const { defaultAudioSettings } = await import("../src/utils/audioSettings");
  const { loadPreferences, preferencesKey } = await import("../src/utils/preferences");
  const audio = { native: false, load: async () => defaultAudioSettings(), devices: async () => [], save: async () => {} };
  const tracks = [song("Combined first"), song("Combined second")];
  const [first, second] = tracks;
  const fixture = {
    [preferencesKey]: { version: 4, ui: {} },
    "ambra.device-view.v1": { version: 4, ui: { screen: "home" } },
    "ambra.playback.v1": { trackId: first.globalId, positionSeconds: 0 },
    "ambra.queue.v1": queueSnapshot([], queueSong(first, 0), [queueSong(second, 1)]),
    [PLAYLIST_STORAGE_KEY]: { version: 1, tracks, playlists: [
      { id: "combined", name: "Combined test playlist", trackIds: tracks.map(track => track.globalId) },
    ] },
  };
  const previous = Object.keys(fixture).map(key => [key, localStorage.getItem(key)] as const);
  for (const [key, value] of Object.entries(fixture)) localStorage.setItem(key, JSON.stringify(value));

  const viewport = document.createElement("div");
  viewport.className = "appViewport";
  document.body.append(viewport);
  const root = createRoot(viewport);
  const find = (selector: string, parent: ParentNode = viewport) => {
    const target = parent.querySelector<HTMLElement>(selector);
    expect(target).not.toBeNull();
    return target!;
  };
  const click = (selector: string) => act(async () => find(selector).click());
  const mouse = (target: Element, type: string, detail: number, button = 0, clientX = 0, clientY = 0) => act(async () => {
    target.dispatchEvent(new dom.MouseEvent(type, { button, detail, clientX, clientY, bubbles: true, cancelable: true }) as unknown as MouseEvent);
  });
  const row = (track: Track) => find(`main .libraryItem[data-track-id="${track.globalId}"]`);
  const menu = () => viewport.querySelector("#trackMenuBackdrop");
  const labels = () => [...menu()!.querySelectorAll("button")].map(button => button.textContent?.trim());
  const removedActions = ["Go to Album", "Go to Artist", "Credits", "Resume"];
  const selectAction = (label: string) => act(async () => {
    const action = [...menu()!.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
    expect(action).toBeDefined();
    action!.click();
  });
  const trigger = '[aria-label="Combined song menu"]';
  const openPlaylist = () => click('[data-tooltip="Combined test playlist"].sidebarPlaylistName');

  try {
    await act(async () => root.render(<AudioSettingsProvider api={audio}><App localOnly /></AudioSettingsProvider>));
    await openPlaylist();
    await mouse(find(".trackName", row(second)), "click", 1);
    expect(menu()?.querySelector("#trackPlaybackMenu")).not.toBeNull();
    await click("#trackMenuBackdrop");

    await click(".sidebarSettingsButton");
    const playlistStats = (provider: string) => `[aria-label="Include ${provider} playlists"]`;
    expect(loadPreferences().ui.libraryStatsPlaylists).toEqual({ qobuz: false, tidal: false, spotify: false });
    await click(playlistStats("Qobuz"));
    await click(playlistStats("Spotify"));
    expect(loadPreferences().ui.libraryStatsPlaylists).toEqual({ qobuz: true, tidal: false, spotify: true });
    await click(playlistStats("Qobuz"));
    await click(playlistStats("Tidal"));
    expect(loadPreferences().ui.libraryStatsPlaylists).toEqual({ qobuz: false, tidal: true, spotify: true });
    expect((find(trigger) as HTMLInputElement).checked).toBe(false);
    await click(trigger);
    expect(loadPreferences().ui.songContextMenu).toBe(true);
    await click('.pageHistoryControls [aria-label="Back"]');
    await openPlaylist();

    const nestedTrigger = find(".trackCollectionMenuTrigger", row(second));
    await mouse(find(".trackPlayButton", row(second)), "click", 1);
    expect(menu()).toBeNull();
    expect(loadPreferences().playback.trackId).toBe(first.globalId);

    await mouse(find("img", nestedTrigger), "click", 1);
    const dotsActions = labels();
    expect(dotsActions).toContain("Play from Here");
    expect(nestedTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(loadPreferences().playback.trackId).toBe(first.globalId);
    await click("#trackMenuBackdrop");

    await mouse(row(second), "contextmenu", 0, 2, 35, 40);
    const combinedActions = labels();
    expect(combinedActions).toEqual(dotsActions);
    expect(combinedActions).toEqual(expect.arrayContaining(["Play from Here", "Add to Queue", "Add to Playlist", "Select Song"]));
    expect(combinedActions.filter(label => label && removedActions.includes(label))).toEqual([]);
    expect(viewport.querySelectorAll("#trackMenuBackdrop")).toHaveLength(1);
    expect(menu()?.hasAttribute("data-song-context-menu")).toBe(true);
    const panel = find("#trackCollectionMenu");
    expect(panel.style.animation).toBe("none");
    expect([panel.style.left, panel.style.top]).toEqual(["35px", "40px"]);
    panel.getBoundingClientRect = () => new dom.DOMRect(0, 0, 220, 300);
    await selectAction("Add to Playlist");
    expect(menu()?.querySelector(".playlistMenuList")).not.toBeNull();
    await mouse(row(first), "contextmenu", 0, 2, 310, 155);
    const moved = find("#trackCollectionMenu");
    expect([moved.style.left, moved.style.top]).toEqual(["310px", "155px"]);
    expect(labels()).toContain("Play from Here");
    expect(labels().filter(label => label && removedActions.includes(label))).toEqual([]);
    expect(moved.style.animation).toBe("none");
    expect(row(first).dataset.menuOpen).toBe("true");
    expect(document.querySelector('#trackCollectionMenu[aria-hidden="true"]')).toBeNull();
    await mouse(find(".sidebarSettingsButton"), "click", 1);
    expect(menu()).toBeNull();
    expect(viewport.querySelector(trigger)).toBeNull();

    await act(async () => { nestedTrigger.focus(); nestedTrigger.click(); });
    expect(labels()).toEqual(combinedActions);
    expect(find("#trackCollectionMenu").style.animation).toBe("");
    await act(async () => {
      document.activeElement!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }) as unknown as KeyboardEvent);
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(nestedTrigger);

    await mouse(row(second), "contextmenu", 0, 2);
    await selectAction("Select Song");
    expect(row(second).dataset.selected).toBe("true");
    await mouse(row(first), "click", 1);
    expect(row(first).dataset.selected).toBeUndefined();
    expect(menu()).toBeNull();

    await click("#queueBtn");
    const queued = find('#playbackSidebar [aria-label="Upcoming songs"] .libraryItem');
    await mouse(find(".trackCollectionMenuTrigger", queued), "click", 1);
    expect(labels()).toContain("Remove from Queue");
    await click("#trackMenuBackdrop");
    await mouse(row(second), "contextmenu", 0, 2, 35, 40);
    await mouse(queued, "contextmenu", 0, 2);
    expect(viewport.querySelectorAll("#trackMenuBackdrop")).toHaveLength(1);
    expect(labels()).toEqual(expect.arrayContaining(["Play from Here", "Move to Front", "Remove from Queue", "Add to Playlist"]));
    expect(labels().filter(label => label && removedActions.includes(label))).toEqual([]);
    await click("#trackMenuBackdrop");
    await mouse(queued, "dblclick", 2);
    expect(menu()).toBeNull();
    expect(loadPreferences().playback.trackId).toBe(second.globalId);

    const firstTrigger = find(".trackCollectionMenuTrigger", row(first));
    await mouse(firstTrigger, "click", 1);
    expect(labels()).toContain("Play from Here");
    await click("#trackMenuBackdrop");
    await mouse(firstTrigger, "dblclick", 2);
    expect(menu()).toBeNull();
    expect(loadPreferences().playback.trackId).toBe(second.globalId);
    await mouse(row(first), "dblclick", 2);
    expect(menu()).toBeNull();
    expect(loadPreferences().playback.trackId).toBe(first.globalId);

    const newQueued = find('#playbackSidebar [aria-label="Upcoming songs"] .libraryItem');
    await mouse(newQueued, "contextmenu", 0, 2);
    await selectAction("Remove from Queue");
    expect(newQueued.isConnected).toBe(false);

    await click(".sidebarSettingsButton");
    await click(trigger);
    expect(loadPreferences().ui.songContextMenu).toBe(false);
    await click('.pageHistoryControls [aria-label="Back"]');
    await openPlaylist();
    await mouse(find(".trackName", row(second)), "click", 1);
    expect(menu()?.querySelector("#trackPlaybackMenu")).not.toBeNull();
    await click("#trackMenuBackdrop");
    await act(async () => find(".trackCollectionMenuTrigger", row(second)).click());
    expect(labels()).toContain("Credits");
  } finally {
    await act(async () => root.unmount());
    viewport.remove();
    for (const [key, value] of previous) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
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
    await click('.pageHistoryControls [aria-label="Back"]');
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
