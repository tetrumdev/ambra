import { highestQualityArtwork } from "../api/server";
import type { Track } from "../types/music";

// Retain decoded, recently used covers across view unmounts. Large artwork has
// its own small budget so it cannot evict the covers needed while scrolling.
const thumbnails = new Map<string, Promise<HTMLImageElement>>();
const fullSize = new Map<string, Promise<HTMLImageElement>>();
const bigscreenSources = new Map<string, string>();
const bigscreenRequests = new Map<string, Promise<string | null>>();
// Covers that fell back to the provider's own image, which may only mean a larger one was briefly unreachable.
const provisionalBigscreenSources = new Set<string>();
const UPCOMING_BIGSCREEN_ARTWORK_COUNT = 2;

export function cachedArtwork(url: string): boolean {
  // Image.complete also becomes true on failure; only successful decodes count.
  const request = thumbnails.get(url);
  return !!request && readyThumbnails.has(url);
}
const readyThumbnails = new Set<string>();

function bigscreenArtworkKey(track: Track) {
  return [
    track.globalId,
    track.provider,
    track.albumId ?? "",
    track.upc ?? "",
    track.nativeCover ?? "",
    // The thumbnail can appear while a track plays; the full image is what is cached.
    track.fullCover ?? track.cover,
  ].join(":");
}

/** Ends once the image has loaded, without decoding it. */
function whenLoaded(image: HTMLImageElement) {
  return new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Artwork failed to load"));
  });
}

/**
 * Has WebKit decode a loaded image on its own decoding threads. HTMLImageElement.decode() reads
 * the image's color space first, and WebKitGTK decodes the whole image on the main thread to do
 * so before decoding it again in the background: over 100 ms for a 4000px cover, a stall in the
 * middle of the song change that asked for it. An image first painted in a new layer is decoded
 * in the background instead, so the image is painted once, out of sight, in a layer of its own.
 * It is drawn at least as large as the screen, as no cover is drawn larger, so that decoded copy
 * serves every later paint of it.
 */
function decodeInBackground(image: HTMLImageElement) {
  const stage = document.createElement("div");
  stage.setAttribute("aria-hidden", "true");
  stage.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;"
    + "opacity:0.001;pointer-events:none;contain:strict;will-change:transform";
  const scale = Math.max(1, Math.max(screen.width, screen.height) / Math.max(1, image.naturalWidth, image.naturalHeight));
  image.style.cssText = `display:block;max-width:none;width:${Math.ceil(image.naturalWidth * scale)}px;`
    + `height:${Math.ceil(image.naturalHeight * scale)}px`;
  stage.append(image);
  document.body.append(stage);
  // The decode is under way once the layer has been painted, and finishes without it.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    stage.remove();
    image.removeAttribute("style");
  }));
}

export function preloadArtwork(url: string, large = false, options: {
  fetchPriority?: HTMLImageElement["fetchPriority"];
  timeoutMs?: number;
  /** For a cover shown later: ends once it has loaded, its decode left to run in the background. */
  background?: boolean;
} = {}) {
  const cache = large ? fullSize : thumbnails;
  const cached = cache.get(url);
  if (cached) {
    cache.delete(url);
    cache.set(url, cached);
    return cached;
  }
  const image = new Image();
  image.decoding = "async";
  image.fetchPriority = options.fetchPriority ?? "auto";
  // A hidden page paints nothing, so there the image is decoded as usual; nobody sees the wait.
  const background = !!options.background && typeof requestAnimationFrame === "function"
    && document.visibilityState === "visible";
  const load = background ? whenLoaded(image) : null;
  image.src = url;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const decoded = load ? load.then(() => decodeInBackground(image)) : image.decode();
  const ready = options.timeoutMs === undefined ? decoded : Promise.race([
    decoded,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        image.src = "";
        reject(new Error("Artwork loading timed out"));
      }, options.timeoutMs);
    }),
  ]);
  const request = ready.then(() => {
    if (!large && cache.get(url) === request) readyThumbnails.add(url);
    return image;
  }).catch((error) => {
    if (cache.get(url) === request) cache.delete(url);
    throw error;
  }).finally(() => { clearTimeout(timer); });
  cache.set(url, request);
  while (cache.size > (large ? 3 : 192)) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
    if (!large) readyThumbnails.delete(oldest);
  }
  return request;
}

export function cachedBigscreenArtwork(track: Track) {
  const source = bigscreenSources.get(bigscreenArtworkKey(track));
  return source && fullSize.has(source) ? source : null;
}

/** Whether the cached cover is final, or a fallback worth resolving again. */
export function settledBigscreenArtwork(track: Track) {
  const key = bigscreenArtworkKey(track);
  return bigscreenSources.has(key) && !provisionalBigscreenSources.has(key);
}

/** `background` is for a cover shown later, as {@link preloadArtwork} has it. */
export function preloadBigscreenArtwork(track: Track, background = false) {
  const key = bigscreenArtworkKey(track);
  const source = bigscreenSources.get(key);
  if (source && !provisionalBigscreenSources.has(key))
    return preloadArtwork(source, true, { timeoutMs: 10_000, background }).then(() => source).catch(() => {
      provisionalBigscreenSources.add(key);
      return null;
    });

  const pending = bigscreenRequests.get(key);
  if (pending) return pending;

  const request = (async () => {
    const artwork = track.provider === "local" ? null : await highestQualityArtwork(track);
    const candidates = [...new Set([
      artwork?.url, source, track.fullCover, track.nativeCover, track.cover,
    ].filter((url): url is string => !!url))];
    let loaded: string | null = null;
    for (const candidate of candidates) {
      try {
        await preloadArtwork(candidate, true, { timeoutMs: 10_000, background });
        loaded = candidate;
        break;
      } catch {
        // A resolver outage or an unreachable alternative must not hide the original cover.
      }
    }
    if (!loaded) return null;
    const final = track.provider === "local" || (artwork && loaded === artwork.url
      && (artwork.complete ?? artwork.url !== track.nativeCover));
    bigscreenSources.delete(key);
    bigscreenSources.set(key, loaded);
    if (!final) provisionalBigscreenSources.add(key);
    else provisionalBigscreenSources.delete(key);
    while (bigscreenSources.size > 12) {
      const oldest = bigscreenSources.keys().next().value!;
      bigscreenSources.delete(oldest);
      provisionalBigscreenSources.delete(oldest);
    }
    return loaded;
  })().catch(() => null).finally(() => {
    if (bigscreenRequests.get(key) === request) {
      bigscreenRequests.delete(key);
    }
  });

  bigscreenRequests.set(key, request);
  return request;
}

export async function preloadUpcomingBigscreenArtwork(
  tracks: Track[],
): Promise<void> {
  await Promise.all(
    tracks
      .slice(0, UPCOMING_BIGSCREEN_ARTWORK_COUNT)
      .map((track) => preloadBigscreenArtwork(track, true)),
  );
}
