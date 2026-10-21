import { useCallback, useEffect, useRef, useState } from "react";
import type { GlobalTrackId, Playlist, Track } from "../types/music";
import { findPlaylistUpgrades } from "../utils/playlistImprovement";
import { playlistTracks } from "../utils/playlists";

export type PlaylistUpgrade = { from: Track; to: Track };

/** Upgrades made since the playlist was last left, or why a requested scan stopped. */
export type PlaylistImprovementReport = { upgrades: PlaylistUpgrade[]; error?: string };

/** A scan the user asked for; background scans report only what they changed. */
export type PlaylistImprovementProgress = { playlistId: string; done: number; total: number };

const SCANS_KEY = "ambra.playlist-improvement-scans.v1";
// Searching every song on every service is heavy, so each playlist is rechecked twice a day.
const RESCAN_AFTER_MS = 12 * 60 * 60_000;
const CHECK_EVERY_MS = 15 * 60_000;
const FIRST_CHECK_MS = 60_000;

function lastScans(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SCANS_KEY) ?? "{}");
    return typeof value === "object" && value !== null ? value as Record<string, number> : {};
  } catch {
    return {};
  }
}

function rememberScan(playlistId: string, playlists: Playlist[]) {
  const scans = lastScans();
  const kept = Object.fromEntries(playlists.filter(playlist => playlist.id in scans).map(playlist => [playlist.id, scans[playlist.id]]));
  try { localStorage.setItem(SCANS_KEY, JSON.stringify({ ...kept, [playlistId]: Date.now() })); } catch { /* Rescanned on the next check. */ }
}

/** A song upgraded twice reads as one change, from the first copy to the latest. */
function mergeUpgrades(previous: PlaylistUpgrade[], next: PlaylistUpgrade[]) {
  const merged = [...previous];
  for (const upgrade of next) {
    const index = merged.findIndex(item => item.to.globalId === upgrade.from.globalId);
    if (index < 0) merged.push(upgrade);
    else merged[index] = { from: merged[index].from, to: upgrade.to };
  }
  return merged;
}

/**
 * Keeps AMBRA playlists on the best-sounding copy of each song: playlists are rescanned in
 * the background, one at a time, and the user can ask for one now.
 */
export function usePlaylistImprovement(
  playlists: Playlist[],
  savedTracks: Track[],
  replaceTracks: (id: string, replacements: Map<GlobalTrackId, Track>) => boolean,
  enabled: boolean,
) {
  const [progress, setProgress] = useState<PlaylistImprovementProgress | null>(null);
  const [reports, setReports] = useState<Record<string, PlaylistImprovementReport>>({});
  const running = useRef<{ controller: AbortController; requested: boolean } | null>(null);
  const latest = useRef({ playlists, savedTracks, replaceTracks });
  latest.current = { playlists, savedTracks, replaceTracks };

  const report = useCallback((playlistId: string, upgrades: PlaylistUpgrade[], error?: string) => {
    setReports(current => ({ ...current, [playlistId]: { upgrades: mergeUpgrades(current[playlistId]?.upgrades ?? [], upgrades), error } }));
  }, []);

  const scan = useCallback(async (playlistId: string, requested: boolean) => {
    const playlist = latest.current.playlists.find(item => item.id === playlistId);
    if (!playlist) return;
    const tracks = playlistTracks(playlist, latest.current.savedTracks);
    const controller = new AbortController();
    running.current = { controller, requested };
    if (requested) setProgress({ playlistId, done: 0, total: tracks.length });
    try {
      const found = await findPlaylistUpgrades(tracks, done => {
        if (requested) setProgress({ playlistId, done, total: tracks.length });
      }, controller.signal);
      const upgrades = [...found].map(([from, to]) => ({ from: tracks.find(track => track.globalId === from)!, to }));
      if (upgrades.length && !latest.current.replaceTracks(playlistId, found)) {
        if (requested) report(playlistId, [], "Could not save the improved playlist. Please try again.");
        return;
      }
      rememberScan(playlistId, latest.current.playlists);
      // An empty report still tells someone who asked that nothing better exists.
      if (upgrades.length || requested) report(playlistId, upgrades);
    } catch {
      if (requested && !controller.signal.aborted) report(playlistId, [], "Could not reach your music services. Please try again.");
    } finally {
      if (running.current?.controller === controller) running.current = null;
      if (requested) setProgress(null);
    }
  }, [report]);

  // Background scans take the stalest playlist first and leave the rest for later checks.
  useEffect(() => {
    if (!enabled) return;
    const check = () => {
      if (running.current) return;
      const scans = lastScans();
      const due = latest.current.playlists
        .filter(playlist => playlist.trackIds.length > 0 && Date.now() - (scans[playlist.id] ?? 0) >= RESCAN_AFTER_MS)
        .sort((a, b) => (scans[a.id] ?? 0) - (scans[b.id] ?? 0))[0];
      if (due) void scan(due.id, false).then(check);
    };
    const first = window.setTimeout(check, FIRST_CHECK_MS);
    const interval = window.setInterval(check, CHECK_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
      running.current?.controller.abort();
    };
  }, [enabled, scan]);

  /** A requested scan replaces a background one, which is picked up again on a later check. */
  const improve = useCallback((playlistId: string) => {
    if (running.current?.requested) return;
    running.current?.controller.abort();
    void scan(playlistId, true);
  }, [scan]);

  /** Leaving a playlist clears what it reported. */
  const clear = useCallback((playlistId: string) => {
    setReports(current => {
      if (!(playlistId in current)) return current;
      const { [playlistId]: _, ...rest } = current;
      return rest;
    });
  }, []);

  return { progress, reports, improve, clear };
}
