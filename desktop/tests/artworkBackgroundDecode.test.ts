import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Track } from "../src/types/music";

const dom = new Window({ url: "http://localhost/", width: 1600, height: 900 });
const { cachedBigscreenArtwork, preloadBigscreenArtwork, preloadUpcomingBigscreenArtwork } = await import("../src/utils/artworkImages");

const frames: FrameRequestCallback[] = [];
const images: HTMLImageElement[] = [];
let decodes = 0;
function nextFrame() {
  for (const callback of frames.splice(0)) callback(0);
}

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, screen: { width: 2560, height: 1440 },
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    Image: function TestImage() {
      const image = dom.document.createElement("img") as unknown as HTMLImageElement;
      Object.defineProperties(image, { naturalWidth: { value: 4000 }, naturalHeight: { value: 4000 } });
      image.decode = () => { decodes++; return Promise.resolve(); };
      images.push(image);
      return image;
    },
  });
});
afterAll(() => { dom.happyDOM.abort(); });

function track(id: string): Track {
  const cover = `asset://localhost/Music/${id}.jpg`;
  return {
    globalId: `local:${id}`, provider: "local", providerTrackId: id, albumId: id,
    playbackKind: "direct", audio: "", cover, nativeCover: cover,
    name: id, album: id, artist: "Artist", artists: [], albumArtists: [], durationSeconds: 180,
  };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("upcoming covers are decoded in a painted layer instead of by decode()", async () => {
  const upcoming = track("upcoming");
  const preloaded = preloadUpcomingBigscreenArtwork([upcoming]);
  await flush();
  const image = images.at(-1)!;
  image.onload!(new dom.Event("load") as unknown as Event);
  await preloaded;

  expect(decodes).toBe(0);
  const stage = image.parentElement!;
  expect(stage.parentElement).toBe(dom.document.body as unknown as HTMLElement);
  expect(stage.style.overflow).toBe("hidden");
  expect(stage.style.willChange).toBe("transform");
  // Drawn at its own size, as the screen is smaller, so its decoded copy serves every cover.
  expect(image.style.width).toBe("4000px");
  expect(cachedBigscreenArtwork(upcoming)).toBe(upcoming.cover);

  nextFrame();
  expect(image.parentElement).toBe(stage);
  nextFrame();
  expect(stage.isConnected).toBe(false);
  expect(image.getAttribute("style")).toBeNull();
});

test("the cover asked for now is still decoded before it is shown", async () => {
  const current = track("current");
  await preloadBigscreenArtwork(current);
  expect(decodes).toBe(1);
  expect(images.at(-1)!.isConnected).toBe(false);
  expect(cachedBigscreenArtwork(current)).toBe(current.cover);
});
