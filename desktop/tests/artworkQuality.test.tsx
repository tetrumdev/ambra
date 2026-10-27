import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { highestQualityArtwork, type ArtworkQuality } from "../src/api/server";
import { setServerForTesting } from "../src/api/serverConnection";
import { cachedBigscreenArtwork, preloadBigscreenArtwork, settledBigscreenArtwork } from "../src/utils/artworkImages";
import type { Track } from "../src/types/music";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, document: dom.document, CSS: { supports: () => false } });
const { AlbumArtwork } = await import("../src/components/BigscreenArtwork");
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalWarn = console.warn;
const timers = new Map<number, { delay: number; run: () => void }>();
let timerId = 1_000_000;
let calls = 0;
let warnings = 0;
let failedImages = new Set<string>();
let respond: () => Response | Promise<Response>;

class ArtworkImage {
  src = "";
  decoding = "";
  fetchPriority = "auto";
  decode() { return failedImages.has(this.src) ? Promise.reject(new Error("CDN unavailable")) : Promise.resolve(); }
}

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
    Image: ArtworkImage, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: () => { calls++; return Promise.resolve(respond()); },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { delay, run: callback });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  console.warn = () => { warnings++; };
  setServerForTesting("http://artwork-server:38147", null);
});
beforeEach(() => { calls = 0; warnings = 0; timers.clear(); failedImages = new Set(); });
afterEach(() => { expect(timers.size).toBe(0); });
afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  console.warn = originalWarn;
  dom.happyDOM.abort();
});

function track(id: string): Track {
  const cover = `https://resources.tidal.com/images/${id}/1280x1280.jpg`;
  return {
    globalId: `tidal:${id}`, provider: "tidal", providerTrackId: id, albumId: id,
    playbackKind: "direct", audio: "", cover, nativeCover: cover,
    name: id, album: id, artist: "Artist", artists: [], albumArtists: [], durationSeconds: 180,
  };
}
function quality(song: Track, complete = true, native = false): ArtworkQuality {
  return {
    provider: native ? "tidal" : "qobuz",
    url: native ? song.nativeCover! : `https://static.qobuz.com/images/${song.albumId}_max.jpg`,
    width: native ? 1280 : 4000, height: native ? 1280 : 4000, colors: [], complete,
  };
}
async function flush() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); }
async function retry(delay: number) {
  const pending = [...timers].find(([, timer]) => timer.delay === delay);
  expect(pending).toBeDefined();
  timers.delete(pending![0]);
  await act(async () => { pending![1].run(); });
  await flush();
}

test("a transient 502 retries automatically and concurrent songs share the successful lookup", async () => {
  const song = track("retry-502");
  respond = () => calls === 1 ? new Response(null, { status: 502 }) : Response.json(quality(song));
  const first = highestQualityArtwork(song);
  expect(highestQualityArtwork(song)).toBe(first);
  await flush();
  expect(calls).toBe(1);
  await retry(400);
  expect((await first)?.url).toBe(quality(song).url);
  expect(await highestQualityArtwork(song)).toEqual(quality(song));
  expect(calls).toBe(2);
  expect(warnings).toBe(0);
});

test("a provisional alternative is never cached as the final highest-quality result", async () => {
  const song = track("provisional-alternative");
  respond = () => Response.json(quality(song, calls > 1));
  expect((await highestQualityArtwork(song))?.complete).toBe(false);
  expect((await highestQualityArtwork(song))?.complete).toBe(true);
  await highestQualityArtwork(song);
  expect(calls).toBe(2);
});

test("a fully inspected source cover is final even when no alternative is larger", async () => {
  const song = track("final-native");
  respond = () => Response.json(quality(song, true, true));
  await preloadBigscreenArtwork(song);
  expect(cachedBigscreenArtwork(song)).toBe(song.nativeCover);
  expect(settledBigscreenArtwork(song)).toBe(true);
  await preloadBigscreenArtwork(song);
  expect(calls).toBe(1);
});

test("an unreachable resolved image uses the original full-size cover and upgrades after recovery", async () => {
  const song = track("image-recovery");
  const best = quality(song);
  respond = () => Response.json(best);
  failedImages.add(best.url);
  expect(await preloadBigscreenArtwork(song)).toBe(song.nativeCover);
  expect(settledBigscreenArtwork(song)).toBe(false);
  failedImages.delete(best.url);
  expect(await preloadBigscreenArtwork(song)).toBe(best.url);
  expect(settledBigscreenArtwork(song)).toBe(true);
});

test("a playing song keeps full-size artwork through resolver failure and upgrades without changing songs", async () => {
  const song = track("visible-recovery");
  let recovered = false;
  respond = () => recovered ? Response.json(quality(song)) : new Response(null, { status: 502 });
  const host = document.createElement("div");
  const root = createRoot(host);
  const visible = () => host.querySelector<HTMLImageElement>('.albumCoverImg[data-leaving="false"]')?.src;
  try {
    await act(async () => root.render(<AlbumArtwork track={song} active />));
    expect(visible()).toBe(song.nativeCover);
    await retry(400);
    await retry(800);
    expect(calls).toBe(3);
    expect(visible()).toBe(song.nativeCover);
    expect(settledBigscreenArtwork(song)).toBe(false);
    expect(warnings).toBe(1);
    recovered = true;
    await retry(1000);
    expect(visible()).toBe(quality(song).url);
    expect(settledBigscreenArtwork(song)).toBe(true);
    expect(calls).toBe(4);
  } finally { await act(async () => root.unmount()); }
});

test("changing songs cancels the previous cover's recovery timer", async () => {
  const old = track("old-provisional");
  const next = track("new-final");
  respond = () => Response.json(quality(old, false, true));
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AlbumArtwork track={old} active />));
    expect([...timers.values()].some(timer => timer.delay === 1000)).toBe(true);
    respond = () => Response.json(quality(next));
    await act(async () => root.render(<AlbumArtwork track={next} active />));
    expect(host.querySelector<HTMLImageElement>('.albumCoverImg[data-leaving="false"]')?.src).toBe(quality(next).url);
    expect(timers.size).toBe(0);
  } finally { await act(async () => root.unmount()); }
});
