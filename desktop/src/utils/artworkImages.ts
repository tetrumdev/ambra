import { highestQualityArtwork } from "../api/server";
import type { Track } from "../types/music";

// Retain decoded, recently used covers across view unmounts. Large artwork has
// its own small budget so it cannot evict the covers needed while scrolling.
const thumbnails = new Map<string, Promise<HTMLImageElement>>();
const fullSize = new Map<string, Promise<HTMLImageElement>>();
const bigscreenSources = new Map<string, string>();
const bigscreenRequests = new Map<string, Promise<string | null>>();

function bigscreenArtworkKey(track: Track) {
  return [
    track.globalId,
    track.provider,
    track.albumId ?? "",
    track.nativeCover ?? "",
    track.cover,
  ].join(":");
}

export function preloadArtwork(url: string, large = false) {
  const cache = large ? fullSize : thumbnails;
  const cached = cache.get(url);
  if (cached) {
    cache.delete(url);
    cache.set(url, cached);
    return cached;
  }
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  const request = image.decode().then(() => image).catch((error) => {
    if (cache.get(url) === request) cache.delete(url);
    throw error;
  });
  cache.set(url, request);
  while (cache.size > (large ? 3 : 192)) cache.delete(cache.keys().next().value!);
  return request;
}

export function cachedBigscreenArtwork(track: Track) {
  const source = bigscreenSources.get(bigscreenArtworkKey(track));
  return source && fullSize.has(source) ? source : null;
}

export function preloadBigscreenArtwork(track: Track) {
  const key = bigscreenArtworkKey(track);
  const source = bigscreenSources.get(key);
  if (source) return preloadArtwork(source, true).then(() => source).catch(() => null);

  const pending = bigscreenRequests.get(key);
  if (pending) return pending;

  const request = (async () => {
    const source = track.provider === "local"
      ? track.cover
      : (await highestQualityArtwork(track))?.url ?? track.cover;
    if (!source) return null;

    await preloadArtwork(source, true);
    bigscreenSources.set(key, source);
    while (bigscreenSources.size > 12) {
      bigscreenSources.delete(bigscreenSources.keys().next().value!);
    }
    return source;
  })().catch(() => null).finally(() => {
    if (bigscreenRequests.get(key) === request) {
      bigscreenRequests.delete(key);
    }
  });

  bigscreenRequests.set(key, request);
  return request;
}
