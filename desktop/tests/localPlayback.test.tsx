import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

const calls: { command: string; args?: Record<string, unknown> }[] = [];
let selectedServer: string | null = null;
let native = { currentSource: null as string | null, currentTime: 0, duration: 180, isPlaying: false, buffering: false, ended: false, error: null, audioQuality: null };
const scanned = { audio: "/Music/Ambra/song.flac", name: "Offline song", artist: "Artist", album: "Album", cover: null, trackNumber: 1, durationSeconds: 180 };
const tauriCore = await import("@tauri-apps/api/core");
mock.module("@tauri-apps/api/core", () => ({
  ...tauriCore,
  isTauri: () => true, convertFileSrc: (source: string) => `asset://localhost${source}`,
  invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "server_connection") return { mode: selectedServer ? "join" : "host", baseUrl: selectedServer ? `http://${selectedServer}:38147` : "http://127.0.0.1:9", token: null,
      server: selectedServer ? { id: selectedServer, name: selectedServer, publicKey: selectedServer } : null, clientId: "local-player", clientName: "Test" };
    if (command === "load_cached_music" || command === "scan_music") return [scanned];
    if (command === "native_audio_status") return { ...native };
    if (command === "load_native_audio") native = { ...native, currentSource: String(args?.source), currentTime: Number(args?.positionSeconds) || 0, isPlaying: args?.autoplay === true };
    if (command === "play_native_audio") native.isPlaying = true;
    if (command === "pause_native_audio") native.isPlaying = false;
    return null;
  },
}));
const tauriEvent = await import("@tauri-apps/api/event");
mock.module("@tauri-apps/api/event", () => ({ ...tauriEvent, listen: async () => () => {} }));
const { useMusicLibrary } = await import("../src/hooks/useMusicLibrary");
const { useQueue } = await import("../src/hooks/useQueue");
const { useAudioPlayer } = await import("../src/hooks/useAudioPlayer");
const { usePlaylists } = await import("../src/hooks/usePlaylists");
const dom = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
let requestCount = 0;
let controls: { play(): void; create(): string | null; release(): Promise<void> };
function Harness({ localOnly = true }: { localOnly?: boolean }) {
  const library = useMusicLibrary(localOnly);
  const queue = useQueue(library.catalogTracks, null, !library.isRestoring);
  const playlists = usePlaylists();
  const player = useAudioPlayer(library.catalogTracks, { trackId: null, positionSeconds: 0 }, {
    next: () => queue.next()?.track, previous: () => queue.previous()?.track,
    completeCurrent: () => queue.completeCurrent()?.track, peekNext: () => queue.peekNext()?.track,
    nextTrack: queue.upcomingEntries[0]?.track,
  }, () => {});
  controls = {
    play() { const track = library.catalogTracks[0]; queue.playStandalone({ track, source: { kind: "library", id: "library", entryId: 1 }, shufflePackageId: null }); player.playTrack(track.globalId); },
    release: player.release,
    create() { return playlists.create("Offline playlist", library.catalogTracks[0]); },
  };
  return <div>{library.tracks.map(track => track.name).join()} {playlists.playlists.map(item => item.name).join()} {player.currentTrack?.name}</div>;
}
beforeAll(() => {
  Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.fetch = (async () => { requestCount++; throw new TypeError("Offline"); }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = originalFetch; dom.happyDOM.abort(); });
test("native scan, local queue, persisted playlists and playback work with no server", async () => {
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(<Harness />); });
  expect(container.textContent).toContain("Offline song");
  await act(async () => { controls.create(); controls.play(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
  expect(calls.some(call => call.command === "load_native_audio" && call.args?.source === scanned.audio && call.args?.autoplay === true)).toBe(true);
  expect(native.isPlaying).toBe(true);
  expect(container.textContent).toContain("Offline playlist");
  expect(JSON.parse(dom.localStorage.getItem("ambra.playlists.v1")!).playlists[0].name).toBe("Offline playlist");
  expect(dom.localStorage.getItem("ambra.queue.v1")).toContain("local:/Music/Ambra/song.flac");
  expect(requestCount).toBe(0);
  expect(calls.some(call => call.command.includes("server") || call.command === "import_local_music")).toBe(false);
  await act(async () => controls.release());
  expect(native.isPlaying).toBe(false);
  const transportCommands = () => calls.filter(call => ["queue_native_audio", "pause_native_audio"].includes(call.command)).length;
  const releasedCommands = transportCommands();
  await act(async () => root.unmount());
  expect(transportCommands()).toBe(releasedCommands);
  const again = createRoot(container as unknown as HTMLElement);
  await act(async () => { again.render(<Harness />); });
  expect(container.textContent).toContain("Offline playlist");
  await act(async () => again.unmount());
});
test("connected playlists use one authoritative collection for display and every edit", async () => {
  const { hydrateServerState, flushServerState } = await import("../src/utils/serverState");
  const { ClientConnectionContext } = await import("../src/hooks/ClientConnectionContext");
  const { setServerForTesting } = await import("../src/api/serverConnection");
  const local = { version: 1, playlists: [{ id: "same", name: "Private local", trackIds: [] }], tracks: [] };
  const remote = { version: 1, playlists: [{ id: "same", name: "MEGA", trackIds: [] }, { id: "setlist", name: "Setlist", trackIds: [] }], tracks: [] };
  dom.localStorage.setItem("ambra.playlists.v1", JSON.stringify(local));
  const posts: { changes: Record<string, string> }[] = [];
  setServerForTesting("http://external:38147", null);
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes("?since=")) return new Promise<Response>(() => {});
    if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return Response.json({ revision: 2 }); }
    return Response.json({ revision: 1, values: { "ambra.playlists.v1": JSON.stringify(remote) } });
  }) as typeof fetch;
  await hydrateServerState();
  let store: ReturnType<typeof usePlaylists>;
  function PlaylistHarness() { store = usePlaylists(); return <div>{store.playlists.map(item => item.name).join(",")}</div>; }
  const container = document.createElement("div"); const root = createRoot(container);
  const render = (connected: boolean, sharedPlayback = false) => <ClientConnectionContext.Provider value={{ connected, sharedPlayback, network: { state: connected ? "ConnectedLocal" : "Offline" }, setSharedPlayback: async () => {}, reconnect: () => {} }}><PlaylistHarness /></ClientConnectionContext.Provider>;
  await act(async () => { root.render(render(true)); });
  expect(container.textContent).toBe("MEGA,Setlist");
  expect(store!.playlists.map(item => item.id)).toEqual(["same", "setlist"]);
  await act(async () => { root.render(render(true, true)); });
  expect(container.textContent).toBe("MEGA,Setlist");
  await act(async () => { expect(store!.rename("same", "Changed on server")).toBe(true); });
  let created: string | null = null;
  let duplicated: string | null = null;
  await act(async () => {
    created = store!.create("New playlist");
    duplicated = store!.duplicate("Copy", []);
  });
  expect(created).toBeTruthy();
  expect(duplicated).toBeTruthy();
  expect(store!.playlists.map(item => item.id)).toContain(created!);
  expect(store!.playlists.map(item => item.id)).toContain(duplicated!);
  await act(async () => { expect(store!.deletePlaylist("setlist")).toBe(true); });
  await flushServerState();
  expect(posts).toHaveLength(1);
  expect(posts[0].changes["ambra.playlists.v1"]).toContain("Changed on server");
  expect(posts[0].changes["ambra.playlists.v1"]).toContain("New playlist");
  expect(posts[0].changes["ambra.playlists.v1"]).toContain("Copy");
  expect(posts[0].changes["ambra.playlists.v1"]).not.toContain("Setlist");
  expect(dom.localStorage.getItem("ambra.playlists.v1")).toBe(JSON.stringify(local));
  await act(async () => { root.render(render(false)); });
  expect(container.textContent).toBe("Private local");
  await act(async () => { root.unmount(); });
});


test("local audio, position, queue, playlists and settings survive repeated live connection changes", async () => {
  const { connectToServer } = await import("../src/api/serverConnection");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ tracks: [] })) as typeof fetch;
  selectedServer = null; await connectToServer();
  const container = document.createElement("div"); const root = createRoot(container);
  try {
    await act(async () => { root.render(<Harness />); });
    await act(async () => { controls.create(); controls.play(); await new Promise(resolve => setTimeout(resolve, 250)); });
    native.currentTime = 42;
    const source = native.currentSource;
    const queue = localStorage.getItem("ambra.queue.v1");
    const playlists = localStorage.getItem("ambra.playlists.v1");
    localStorage.setItem("ambra.audio-settings.v1", "private audio settings");
    const initialCalls = calls.length;
    for (const server of ["first", "second", null, "first", null]) {
      await act(async () => { selectedServer = server; await connectToServer(); root.render(<Harness localOnly={!server} />); });
      expect(native.isPlaying).toBe(true); expect(native.currentSource).toBe(source); expect(native.currentTime).toBe(42);
      expect(localStorage.getItem("ambra.queue.v1")).toBe(queue);
      expect(localStorage.getItem("ambra.playlists.v1")).toBe(playlists);
      expect(localStorage.getItem("ambra.audio-settings.v1")).toBe("private audio settings");
    }
    expect(calls.slice(initialCalls).filter(call => ["load_native_audio", "pause_native_audio", "restart_app"].includes(call.command))).toEqual([]);
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = previousFetch;
  }
});
