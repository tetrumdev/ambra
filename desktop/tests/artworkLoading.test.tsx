import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Track } from "../src/types/music";
import { providerThumbnail } from "../src/utils/providerThumbnail";

let cacheReads = 0;
mock.module("../src/utils/playlistArtworkCache", () => ({
  cachedPlaylistArtwork: () => { cacheReads++; return new Promise(() => {}); },
}));
const { TrackArtwork } = await import("../src/components/TrackArtwork");
const { setServerForTesting } = await import("../src/api/serverConnection");
const { preloadArtwork } = await import("../src/utils/artworkImages");
const dom = new Window({ url: "http://localhost/" });
const requests: PendingImage[] = [];
class PendingImage {
  src = "";
  decoding = "";
  fetchPriority = "auto";
  resolve!: () => void;
  reject!: (error: Error) => void;
  constructor() { requests.push(this); }
  decode() {
    return new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }
}
beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
    Image: PendingImage, IS_REACT_ACT_ENVIRONMENT: true,
  });
  setServerForTesting("http://paired-server:38147", null);
});
afterAll(() => { dom.happyDOM.abort(); });

function track(id: string): Track {
  return {
    globalId: `tidal:${id}`, provider: "tidal", providerTrackId: id, playbackKind: "direct",
    audio: "", cover: `https://resources.tidal.com/images/${id}/1280x1280.jpg`,
    nativeCover: `https://resources.tidal.com/images/${id}/1280x1280.jpg`,
    name: id, album: id, artist: "Artist", artists: [], albumArtists: [], durationSeconds: 180,
  };
}

test("search thumbnails use small CDN variants without changing portraits or local artwork", () => {
  expect(providerThumbnail(track("sizes").cover)).toBe("https://resources.tidal.com/images/sizes/320x320.jpg");
  expect(providerThumbnail("https://static.qobuz.com/images/album_max.jpg")).toBe("https://static.qobuz.com/images/album_300.jpg");
  expect(providerThumbnail("https://static.qobuz.com/images/artist_portrait.jpg")).toBe("https://static.qobuz.com/images/artist_portrait.jpg");
  expect(providerThumbnail("https://i.scdn.co/image/recording")).toBe("https://i.scdn.co/image/recording");
  expect(providerThumbnail("asset://localhost/Music/cover.jpg")).toBe("asset://localhost/Music/cover.jpg");
});

test("search starts a high-priority cover without waiting for a blocked playlist cache", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const song = track("immediate");
  const before = requests.length;
  await act(async () => { root.render(<TrackArtwork track={song} preferProviderThumbnail loading="eager" fetchPriority="high" />); });
  const image = requests[before];
  expect(image.src).toBe(providerThumbnail(song.cover));
  expect(image.fetchPriority).toBe("high");
  expect(cacheReads).toBe(0);
  await act(async () => { image.resolve(); });
  expect(container.querySelector("img")?.src).toBe(providerThumbnail(song.cover));
  await act(async () => { root.unmount(); });
});

test("an unreachable CDN falls back to the paired server's thumbnail", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const before = requests.length;
  await act(async () => { root.render(<TrackArtwork track={track("fallback")} preferProviderThumbnail loading="eager" />); });
  await act(async () => { requests[before].reject(new Error("CDN unavailable")); });
  const fallback = requests[before + 1];
  expect(fallback.src).toStartWith("http://paired-server:38147/api/artwork/thumbnail?");
  await act(async () => { fallback.resolve(); });
  expect(container.querySelector("img")?.src).toBe(fallback.src);
  await act(async () => { root.unmount(); });
});

test("a late cover cannot replace a newer search result", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const before = requests.length;
  await act(async () => { root.render(<TrackArtwork track={track("old")} preferProviderThumbnail loading="eager" />); });
  await act(async () => { root.render(<TrackArtwork track={track("new")} preferProviderThumbnail loading="eager" />); });
  await act(async () => { requests[before + 1].resolve(); });
  await act(async () => { requests[before].resolve(); });
  expect(container.querySelector("img")?.src).toBe(providerThumbnail(track("new").cover));
  await act(async () => { root.unmount(); });
});

test("a stalled cover times out, releases its request, and can be retried", async () => {
  const source = providerThumbnail(track("timeout").cover);
  const before = requests.length;
  await expect(preloadArtwork(source, false, { timeoutMs: 10 })).rejects.toThrow("Artwork loading timed out");
  expect(requests[before].src).toBe("");
  const retry = preloadArtwork(source, false, { timeoutMs: 1000 });
  expect(requests.length).toBe(before + 2);
  requests[before + 1].resolve();
  await expect(retry).resolves.toBe(requests[before + 1]);
});
