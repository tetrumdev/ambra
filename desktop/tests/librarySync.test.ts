import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { setServerForTesting } from "../src/api/serverConnection";
import { useMusicLibrary } from "../src/hooks/useMusicLibrary";
import { parseCachedServerLibrary } from "../src/utils/libraryCache";
import { playableTrack, type RemoteTrack } from "../src/api/server";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function streaming(id: string, title: string): RemoteTrack {
  return {
    id: `tidal:${id}`, provider: "tidal", providerTrackId: id, title,
    version: null, primaryArtist: { providerId: "artist", name: "Artist", imageUrl: null },
    artists: [], album: null, durationSeconds: 200, trackNumber: null, discNumber: null,
    explicit: false, isrc: null, copyright: null, quality: null,
    maximumSamplingRateKHz: null, maximumBitDepth: null,
    playback: { kind: "direct", url: `/api/stream/${id}` },
  };
}

function local(id: string, name: string) {
  return {
    globalId: `local:${id}`, provider: "local", providerTrackId: id, name,
    audio: `/api/music/local/files/${id}`, cover: "/white.svg", playbackKind: "direct",
  };
}

test("saved cursors require the matching complete cache and legacy track arrays still load", () => {
  const track = playableTrack(streaming("1", "One"));
  expect(parseCachedServerLibrary(JSON.stringify([track])).tracks[0].globalId).toBe("tidal:1");
  expect(parseCachedServerLibrary(JSON.stringify({ tracks: [track], cursor: "abc:1" })).cursor).toBe("abc:1");
  const incomplete = parseCachedServerLibrary(JSON.stringify({ tracks: [track, {}], cursor: "abc:1" }));
  expect(incomplete.tracks).toHaveLength(1);
  expect(incomplete.cursor).toBeUndefined();
});

test("current servers send only changed library data after events, reconnects and remounts", async () => {
  setServerForTesting("http://library-sync.test", null);
  const dom = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.createElement("div"));
  const requests: [string, string | null][] = [];
  let eventStream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let streamingCursor = "stream:0";
  let localCursor = "local:0";
  let services = { tidal: true, qobuz: false, spotify: false };
  let streamingTracks = [streaming("1", "First"), streaming("2", "Second")];
  let localTracks = [local("a", "Alpha"), local("c", "Gamma")];
  let streamingChanges = [streaming("2", "Renamed")];
  let removedTrackIds = ["tidal:1"];
  let updatedTrackIds: string[] = [];
  let localChanges = [local("a", "Renamed Alpha"), local("b", "Beta")];
  const send = () => eventStream?.enqueue(new TextEncoder().encode(
    JSON.stringify({ streaming: streamingCursor, local: localCursor, services }) + "\n",
  ));

  globalThis.fetch = (async (input, options) => {
    const url = new URL(String(input));
    const since = url.searchParams.get("since");
    requests.push([url.pathname, since]);
    if (url.pathname.endsWith("/events")) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          eventStream = controller;
          options?.signal?.addEventListener("abort", () => {
            if (eventStream === controller) {
              eventStream = undefined;
              controller.close();
            }
          }, { once: true });
          send();
        },
      }));
    }
    if (url.pathname === "/api/library") {
      const reset = since !== "stream:0" && since !== "stream:1";
      return Response.json({
        cursor: streamingCursor, reset,
        tracks: reset ? streamingTracks : streamingChanges,
        removedTrackIds: reset ? [] : removedTrackIds,
        updatedTrackIds: reset ? [] : updatedTrackIds,
      });
    }
    if (url.pathname === "/api/music/local/tracks") {
      const reset = since !== "local:0" && since !== "local:1";
      return Response.json({ cursor: localCursor, reset, tracks: reset ? localTracks : localChanges });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;

  let library: ReturnType<typeof useMusicLibrary>;
  function Harness() {
    library = useMusicLibrary(false, true);
    return null;
  }
  const tick = async (update: () => void) => {
    await act(async () => {
      update();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };
  const names = () => library.catalogTracks.map(track => track.name);
  const localRequests = () => requests.filter(([path]) => path.endsWith("/tracks")).map(([, since]) => since);
  const streamingRequests = () => requests.filter(([path]) => path === "/api/library").map(([, since]) => since);

  try {
    await tick(() => root.render(createElement(Harness)));
    expect(names()).toEqual(["First", "Second", "Alpha", "Gamma"]);
    const gamma = library!.catalogTracks.at(-1);
    expect(streamingRequests()).toEqual([""]);
    expect(localRequests()).toEqual([""]);

    await tick(() => {
      send();
      eventStream!.enqueue(new TextEncoder().encode("\n\n"));
    });
    expect(streamingRequests()).toEqual([""]);
    expect(localRequests()).toEqual([""]);

    await tick(() => {
      streamingCursor = "stream:1"; localCursor = "local:1"; send();
    });
    expect(names()).toEqual(["Renamed", "Renamed Alpha", "Beta", "Gamma"]);
    expect(library!.catalogTracks.at(-1)).toBe(gamma);
    expect(streamingRequests()).toEqual(["", "stream:0"]);
    expect(localRequests()).toEqual(["", "local:0"]);

    await tick(() => {
      eventStream!.close();
      eventStream = undefined;
    });
    expect(library!.isServerReachable).toBeFalse();
    expect(names()).toEqual(["Renamed", "Renamed Alpha", "Beta", "Gamma"]);
    await tick(() => {
      streamingCursor = "stream:2"; localCursor = "local:2";
      streamingChanges = [streaming("2", "Downloaded"), streaming("3", "Third")];
      removedTrackIds = []; updatedTrackIds = ["tidal:2"];
      localChanges = [local("c", "Updated Gamma")];
      window.dispatchEvent(new dom.Event("online") as unknown as Event);
    });
    expect(library!.isServerReachable).toBeTrue();
    expect(names()).toEqual(["Downloaded", "Third", "Renamed Alpha", "Beta", "Updated Gamma"]);
    expect(streamingRequests()).toEqual(["", "stream:0", "stream:1"]);
    expect(localRequests()).toEqual(["", "local:0", "local:1"]);

    await tick(() => root.render(createElement(Harness, { key: "remount" })));
    expect(names()).toEqual(["Downloaded", "Third", "Renamed Alpha", "Beta", "Updated Gamma"]);
    expect(streamingRequests()).toHaveLength(3);
    expect(localRequests()).toHaveLength(3);

    await tick(() => {
      streamingCursor = "restart:0"; localCursor = "restart-local:0";
      streamingTracks = [streaming("4", "Replacement")];
      localTracks = [local("d", "New Local")];
      services = { ...services, qobuz: true };
      send();
    });
    expect(names()).toEqual(["Replacement", "New Local"]);
    expect(streamingRequests()).toEqual(["", "stream:0", "stream:1", "stream:2"]);
    expect(localRequests()).toEqual(["", "local:0", "local:1", "local:2"]);
  } finally {
    await act(async () => root.unmount());
    dom.happyDOM.abort();
  }
});

test("older servers still use the legacy library endpoints", async () => {
  setServerForTesting("http://legacy-library.test", null);
  const dom = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom, document: dom.document, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.createElement("div"));
  const requests: string[] = [];
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith("/events")) return new Response(null, { status: 404 });
    if (url.pathname === "/api/library") return Response.json({ tracks: [streaming("1", "Legacy Stream")] });
    if (url.pathname.endsWith("/tracks")) return Response.json([local("a", "Legacy Local")]);
    throw new Error(`Unexpected request ${url.pathname}`);
  }) as typeof fetch;
  let names: string[] = [];
  function Harness() {
    names = useMusicLibrary(false, true).catalogTracks.map(track => track.name);
    return null;
  }
  try {
    await act(async () => { root.render(createElement(Harness)); });
    expect(names).toEqual(["Legacy Stream", "Legacy Local"]);
    expect(requests).toEqual(["/api/library/events", "/api/music/local/tracks?known=", "/api/library"]);
  } finally {
    await act(async () => root.unmount());
    dom.happyDOM.abort();
  }
});
