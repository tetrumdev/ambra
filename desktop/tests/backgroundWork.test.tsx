import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePlaylistImprovement } from "../src/hooks/usePlaylistImprovement";
import { updateServiceAvailability, useServiceAvailability } from "../src/hooks/useServiceAvailability";
import { useServicePlaylists } from "../src/hooks/useServicePlaylists";
import { refreshServerDownloads, useDownloadJobs } from "../src/utils/offlineDownloads";
import type { RemoteTrack, StreamingProvider } from "../src/api/server";
import type { Playlist } from "../src/types/music";

const dom = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
const services = { tidal: true, qobuz: false, spotify: false };
let root: Root;

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  });
  updateServiceAvailability(services);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  globalThis.fetch = originalFetch;
  localStorage.clear();
});
afterAll(() => { dom.happyDOM.abort(); });

test("failed background playlist scans retry at the next scheduled check", async () => {
  const playlists: Playlist[] = [{ id: "one", name: "One", trackIds: ["tidal:one"] }];
  let attempts = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/api/search/providers")) {
      if (++attempts <= 3) return new Response(null, { status: 503 });
      return Response.json({ providers: [] });
    }
    return Response.json(services);
  }) as typeof fetch;
  const originalTimeout = dom.setTimeout;
  const originalInterval = dom.setInterval;
  let firstCheck!: () => void;
  let periodicCheck!: () => void;
  dom.setTimeout = ((callback, delay) => {
    if (delay === 60_000) { firstCheck = callback; return 0; }
    return originalTimeout.call(dom, callback, delay);
  }) as typeof dom.setTimeout;
  dom.setInterval = ((callback, delay) => {
    if (delay === 900_000) { periodicCheck = callback; return 0; }
    return originalInterval.call(dom, callback, delay);
  }) as typeof dom.setInterval;
  function View() {
    usePlaylistImprovement(playlists, [], () => true, true);
    return null;
  }
  try {
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<View />));
    await act(async () => firstCheck());
    expect(attempts).toBe(1);
    await act(async () => periodicCheck());
    expect(attempts).toBe(2);
  } finally {
    dom.setTimeout = originalTimeout;
    dom.setInterval = originalInterval;
  }
});

test("service playlist refreshes retain identical listings and apply real changes", async () => {
  let name = "One";
  let listings = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/api/providers/tidal/playlists")) {
      listings++;
      return Response.json([{ id: "one", name, trackCount: 0, editable: true }]);
    }
    return Response.json(services);
  }) as typeof fetch;
  let store!: ReturnType<typeof useServicePlaylists>;
  function View() {
    store = useServicePlaylists(null, true);
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<View />));
  const initial = store.playlists;
  expect(initial.map(playlist => playlist.name)).toEqual(["One"]);
  await act(async () => store.refresh());
  expect(listings).toBe(2);
  expect(store.playlists).toBe(initial);
  name = "Renamed";
  await act(async () => store.refresh());
  expect(store.playlists.map(playlist => playlist.name)).toEqual(["Renamed"]);
});

test("library stats load unopened playlists for enabled services and drop unlisted tracks", async () => {
  const connected = { tidal: true, qobuz: true, spotify: true };
  updateServiceAvailability(connected);
  const playlist = (id: string) => ({ id, name: id, trackCount: 1, editable: false });
  let tidalPlaylists = [playlist("one"), playlist("two")];
  let qobuzUnavailable = true;
  const requested: string[] = [];
  globalThis.fetch = (async (input) => {
    const path = String(input).match(/\/api\/providers\/(tidal|qobuz|spotify)\/playlists(?:\/(\w+))?$/);
    if (!path) return Response.json(connected);
    const provider = path[1] as StreamingProvider;
    const id = path[2];
    if (!id) return Response.json(provider === "tidal" ? tidalPlaylists : [playlist("one")]);
    requested.push(`${provider}:${id}`);
    if (provider === "qobuz" && qobuzUnavailable) return new Response(null, { status: 503 });
    const trackId = `${provider}:song`;
    const track: RemoteTrack = {
      id: trackId, provider, providerTrackId: "song", title: "Song", version: null,
      primaryArtist: { providerId: "artist", name: "Artist", imageUrl: null },
      artists: [], album: null, durationSeconds: 200, trackNumber: null, discNumber: null,
      explicit: false, isrc: null, copyright: null, quality: null,
      maximumSamplingRateKHz: null, maximumBitDepth: null,
      playback: { kind: "direct", url: "/api/stream/song" },
    };
    return Response.json({
      playlist: playlist(id), entries: [], revision: "1", tracks: [track], unavailableCount: 0,
    });
  }) as typeof fetch;
  let store!: ReturnType<typeof useServicePlaylists>;
  function View({ sources }: { sources: Record<StreamingProvider, boolean> }) {
    store = useServicePlaylists(null, true, false, sources);
    return null;
  }
  root = createRoot(document.createElement("div"));
  const render = (tidal: boolean, qobuz: boolean) => act(async () => {
    root.render(<View sources={{ tidal, qobuz, spotify: false }} />);
  });
  const ids = () => store.statsTracks.map(track => track.globalId).sort();
  try {
    await render(false, false);
    expect(requested).toEqual([]);
    await render(true, true);
    expect(requested.sort()).toEqual(["qobuz:one", "tidal:one", "tidal:two"]);
    expect(ids()).toEqual(["tidal:song"]);
    qobuzUnavailable = false;
    await act(async () => store.refresh());
    expect(ids()).toEqual(["qobuz:song", "tidal:song"]);
    await render(true, false);
    expect(ids()).toEqual(["tidal:song"]);
    tidalPlaylists = [];
    await act(async () => store.refresh());
    expect(ids()).toEqual([]);
  } finally {
    await act(async () => updateServiceAvailability(services));
  }
});

test("download progress renders job subscribers while availability changes reach the library", async () => {
  let done = 0;
  let entries: { id: string }[] = [];
  globalThis.fetch = (async (url) => String(url).endsWith("/api/downloads")
    ? Response.json({ entries, jobs: [{ id: 1, done }] }) : Response.json(services)) as typeof fetch;
  let availabilityRenders = 0;
  let latestProgress = -1;
  function Availability() {
    useServiceAvailability();
    availabilityRenders++;
    return null;
  }
  function Jobs() {
    latestProgress = useDownloadJobs()[0]?.done ?? -1;
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<><Availability /><Jobs /></>));
  const initialRenders = availabilityRenders;
  for (done = 0; done < 5; done++) {
    await act(async () => refreshServerDownloads());
    expect(latestProgress).toBe(done);
  }
  expect(availabilityRenders).toBe(initialRenders);
  entries = [{ id: "tidal:one" }];
  await act(async () => refreshServerDownloads());
  expect(availabilityRenders).toBe(initialRenders + 1);
});
