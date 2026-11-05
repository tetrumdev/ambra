import { configuredSearchProviders, resolveTrackPlayback, searchServerCatalog } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { findUpgrades, type UpgradeServices } from "./playlistUpgrades";

export { packageCopies, unifyAlbumServices } from "./playlistUpgrades";

const desktopServices: UpgradeServices = {
  providers: signal => configuredSearchProviders(signal),
  catalog: (query, provider, signal) => searchServerCatalog(query, provider, signal).then(page => page.tracks),
  playback: (track, signal) => resolveTrackPlayback(track, signal),
};

/** Finds the copy each streamed song should be on, through this computer's server connection. */
export function findPlaylistUpgrades(
  tracks: Track[],
  onProgress: (done: number) => void,
  signal: AbortSignal,
  packages: GlobalTrackId[][] = [],
): Promise<Map<GlobalTrackId, Track>> {
  return findUpgrades(desktopServices, tracks, onProgress, signal, packages);
}
