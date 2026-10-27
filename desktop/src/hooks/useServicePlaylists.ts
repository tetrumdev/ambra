import { getServerConnection, subscribeServerConnection, serverBaseUrl } from "../api/serverConnection";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { serviceAuthStatus, type StreamingProvider } from "../api/server";
import { changeServicePlaylist, deleteServicePlaylist, servicePlaylistContents, servicePlaylists } from "../api/playlists";
import type { Playlist, Track } from "../types/music";
import { musicProviderName } from "../utils/musicProviderName";
import { loadServicePlaylistCache, outdatedContents, saveServicePlaylistCache, TRACK_DETAILS_VERSION, type CachedPlaylistContents } from "../utils/servicePlaylistCache";
import { isTrackAvailable, useServiceAvailability } from "./useServiceAvailability";

export type PlaylistServiceGroup = {
  provider: StreamingProvider;
  playlists: Playlist[];
  error: string | null;
};

const providers: StreamingProvider[] = ["spotify", "qobuz", "tidal"];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const playlistId = (provider: StreamingProvider, id: string) => `service:${provider}:${id}`;
/** An open playlist cached longer than this is quietly checked for changes. */
const OPEN_REVALIDATE_MS = 5 * 60_000;

/**
 * How a playlist's cached contents are reused: "preload" refetches only when the service
 * lists a different name or track count, "open" also when the copy is old, "force" always.
 */
type LoadMode = "preload" | "open" | "force";

function needsFetch(cached: CachedPlaylistContents | undefined, playlist: Playlist, mode: LoadMode) {
  if (!cached || mode === "force" || outdatedContents(cached)) return true;
  if (cached.playlist.name !== playlist.name || cached.playlist.trackCount !== playlist.trackCount) return true;
  return mode === "open" && Date.now() - cached.fetchedAt > OPEN_REVALIDATE_MS;
}

export function useServicePlaylists(selectedId: string | null, enabled: boolean, preloadHome = false) {
  const connection = useSyncExternalStore(subscribeServerConnection, getServerConnection);
  const serverKey = connection?.baseUrl ?? serverBaseUrl;
  const cacheServer = useRef(serverKey);
  const connectedServices = useServiceAvailability();
  const [groups, setGroups] = useState<PlaylistServiceGroup[]>([]);
  const [contents, setContents] = useState<Record<string, CachedPlaylistContents>>({});
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const currentGroups = useRef(groups);
  currentGroups.current = groups;
  const currentContents = useRef(contents);
  currentContents.current = contents;
  const selection = useRef(selectedId);
  selection.current = selectedId;
  const requests = useRef(new Map<string, { controller: AbortController; promise: Promise<void> }>());
  const mutations = useRef(new Set<string>());
  const alive = useRef(true);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!connectedServices) return;
    const available = (provider: StreamingProvider) => connectedServices[provider];
    for (const [id, request] of requests.current) {
      if (providers.some(provider => !available(provider) && id.startsWith(`service:${provider}:`))) request.controller.abort();
    }
    currentGroups.current = currentGroups.current.filter(group => available(group.provider));
    setGroups(currentGroups.current);
    currentContents.current = Object.fromEntries(Object.entries(currentContents.current).filter(([id]) =>
      !providers.some(provider => !available(provider) && id.startsWith(`service:${provider}:`))));
    setContents(currentContents.current);
  }, [connectedServices]);

  const load = useCallback((playlist: Playlist, mode: LoadMode = "open"): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (!playlist.provider || !playlist.remoteId) return Promise.resolve();
    if (!isTrackAvailable(`${playlist.provider}:`)) return Promise.resolve();
    const existing = requests.current.get(playlist.id);
    if (existing && mode !== "force") return existing.promise;
    const cached = currentContents.current[playlist.id];
    if (!needsFetch(cached, playlist, mode)) return Promise.resolve();
    existing?.controller.abort();
    const controller = new AbortController();
    // A cached copy stays on screen while it is revalidated, without a loading state.
    if (!cached) setLoading(current => new Set(current).add(playlist.id));
    const promise = servicePlaylistContents(playlist.provider, playlist.remoteId, AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]))
      .then(result => {
        if (!alive.current || controller.signal.aborted || !isTrackAvailable(`${playlist.provider}:`)) return;
        currentContents.current = { ...currentContents.current, [playlist.id]: { ...result, fetchedAt: Date.now(), detailsVersion: TRACK_DETAILS_VERSION } };
        setContents(currentContents.current);
        setErrors(current => { const next = { ...current }; delete next[playlist.id]; return next; });
      })
      .catch(reason => {
        if (!alive.current || controller.signal.aborted) return;
        // A failed background check keeps showing the cached copy.
        if (currentContents.current[playlist.id] && mode !== "force") return;
        setErrors(current => ({ ...current, [playlist.id]: message(reason) }));
      })
      .finally(() => {
        if (requests.current.get(playlist.id)?.controller !== controller) return;
        requests.current.delete(playlist.id);
        if (alive.current) setLoading(current => { const next = new Set(current); next.delete(playlist.id); return next; });
      });
    requests.current.set(playlist.id, { controller, promise });
    return promise;
  }, [enabled, serverKey]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) return;
    try {
      const connected = await serviceAuthStatus();
      await Promise.all(providers.filter(provider => connected[provider]).map(async provider => {
        try {
          const remote = await servicePlaylists(provider, signal);
          if (!alive.current || signal?.aborted || !isTrackAvailable(`${provider}:`)) return;
          const playlists: Playlist[] = remote.map(playlist => ({ ...playlist, id: playlistId(provider, playlist.id), remoteId: playlist.id, provider, trackIds: [] }));
          setGroups(current => {
            const next = [...current.filter(group => group.provider !== provider), { provider, playlists, error: null }];
            currentGroups.current = next;
            return next;
          });
          const active = playlists.find(playlist => playlist.id === selection.current);
          if (active && !mutations.current.has(active.id)) void load(active);
        } catch (reason) {
          if (!alive.current || signal?.aborted || !isTrackAvailable(`${provider}:`)) return;
          setGroups(current => {
            const old = current.find(group => group.provider === provider);
            const next = [...current.filter(group => group.provider !== provider), { provider, playlists: old?.playlists ?? [], error: message(reason) }];
            currentGroups.current = next;
            return next;
          });
        }
      }));
      if (!alive.current || signal?.aborted) return;
      setGroups(current => {
        const next = current.filter(group => connected[group.provider] && isTrackAvailable(`${group.provider}:`));
        currentGroups.current = next;
        return next;
      });
      setError(null);
    } catch (reason) {
      if (alive.current && !signal?.aborted) setError(`Could not refresh service playlists. ${message(reason)}`);
    }
  }, [load, enabled]);

  // Cached playlists show at once; anything a refresh already fetched takes precedence.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadServicePlaylistCache().then(cache => {
      if (cancelled) return;
      if (cache) {
        const groups = [...currentGroups.current, ...cache.groups
          .filter(group => isTrackAvailable(`${group.provider}:`) && !currentGroups.current.some(current => current.provider === group.provider))
          .map(group => ({ ...group, error: null }))];
        currentGroups.current = groups;
        setGroups(groups);
        currentContents.current = { ...Object.fromEntries(Object.entries(cache.contents).filter(([id]) =>
          !providers.some(provider => !isTrackAvailable(`${provider}:`) && id.startsWith(`service:${provider}:`)))), ...currentContents.current };
        setContents(currentContents.current);
      }
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, [enabled, serverKey]);

  useEffect(() => {
    if (!hydrated || cacheServer.current !== serverKey) return;
    saveServicePlaylistCache({ version: 1, groups: groups.map(({ provider, playlists }) => ({ provider, playlists })), contents });
  }, [hydrated, groups, contents, serverKey]);

  useEffect(() => {
    if (cacheServer.current === serverKey) return;
    cacheServer.current = serverKey;
    currentGroups.current = []; currentContents.current = {};
    setGroups([]); setContents({}); setHydrated(false); setError(null); setErrors({});
    for (const request of requests.current.values()) request.controller.abort();
    requests.current.clear();
  }, [serverKey]);

  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    let controller = new AbortController();
    const update = () => {
      if (document.hidden) return;
      controller.abort();
      controller = new AbortController();
      void refresh(controller.signal);
    };
    update();
    const interval = setInterval(update, 60_000);
    window.addEventListener("focus", update);
    window.addEventListener("online", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      alive.current = false;
      controller.abort();
      clearInterval(interval);
      window.removeEventListener("focus", update);
      window.removeEventListener("online", update);
      document.removeEventListener("visibilitychange", update);
      for (const request of requests.current.values()) request.controller.abort();
      requests.current.clear();
    };
  }, [refresh, enabled, serverKey]);

  useEffect(() => {
    const playlist = currentGroups.current.flatMap(group => group.playlists).find(playlist => playlist.id === selectedId);
    if (playlist) void load(playlist);
  }, [selectedId, load, hydrated]);

  // Contents cached before the server described tracks differently refetch quietly, so stale
  // details (like a publisher listed as an artist) don't outlive the change. The cached copy
  // stays on screen meanwhile.
  useEffect(() => {
    if (!enabled || !hydrated) return;
    const outdated = groups.flatMap(group => group.playlists).filter(playlist => outdatedContents(currentContents.current[playlist.id]));
    let cancelled = false;
    let next = 0;
    const workers = Array.from({ length: Math.min(2, outdated.length) }, async () => {
      while (!cancelled && next < outdated.length) {
        await load(outdated[next++], "preload");
      }
    });
    void Promise.all(workers);
    return () => { cancelled = true; };
  }, [enabled, hydrated, groups, load]);

  useEffect(() => {
    if (!enabled || !preloadHome) return;
    const playlists = providers.flatMap(provider => groups.find(group => group.provider === provider)?.playlists ?? [])
      .filter(playlist => playlist.trackCount !== 0 && needsFetch(currentContents.current[playlist.id], playlist, "preload"));
    let cancelled = false;
    let next = 0;
    // Home needs track metadata for its cover grids before a playlist is opened.
    const workers = Array.from({ length: Math.min(3, playlists.length) }, async () => {
      while (!cancelled && next < playlists.length) {
        await load(playlists[next++], "preload");
      }
    });
    void Promise.all(workers);
    return () => { cancelled = true; };
  }, [enabled, preloadHome, groups, load]);

  const playlists = useMemo(() => providers.flatMap(provider => groups.find(group => group.provider === provider)?.playlists ?? []).map(playlist => {
    const result = contents[playlist.id];
    return result ? { ...playlist, trackIds: [...new Set(result.tracks.map(track => track.globalId))] } : playlist;
  }), [groups, contents]);
  const tracks = useMemo(() => [...new Map(Object.values(contents).flatMap(result => result.tracks).map(track => [track.globalId, track])).values()], [contents]);

  async function change(id: string, track?: Track, trackIds?: string[]): Promise<boolean> {
    const playlist = playlists.find(item => item.id === id);
    if (!playlist?.provider || !playlist.remoteId || !playlist.editable || mutations.current.has(id)) return false;
    mutations.current.add(id);
    setBusy(new Set(mutations.current));
    setError(null);
    try {
      if (track) await changeServicePlaylist(playlist.provider, playlist.remoteId, { action: "add", track });
      else {
        const result = currentContents.current[id];
        if (!result) throw new Error("Load the playlist before removing tracks.");
        const ids = result.tracks.filter(track => trackIds?.includes(track.globalId)).map(track => track.providerTrackId);
        await changeServicePlaylist(playlist.provider, playlist.remoteId, { action: "remove", trackIds: ids, revision: result.revision });
      }
      await load(playlist, "force");
      return true;
    } catch (reason) {
      setError(`${musicProviderName(playlist.provider)}: ${message(reason)}`);
      void load(playlist, "force");
      throw reason;
    } finally {
      mutations.current.delete(id);
      if (alive.current) setBusy(new Set(mutations.current));
    }
  }

  async function edit(id: string, name?: string): Promise<boolean> {
    const playlist = playlists.find(item => item.id === id);
    if (!playlist?.provider || !playlist.remoteId || !playlist.editable || mutations.current.has(id)) return false;
    mutations.current.add(id);
    setBusy(new Set(mutations.current));
    setError(null);
    try {
      if (name === undefined) await deleteServicePlaylist(playlist.provider, playlist.remoteId);
      else await changeServicePlaylist(playlist.provider, playlist.remoteId, { action: "rename", name });
      if (!alive.current) return true;
      setGroups(current => {
        const next = current.map(group => group.provider !== playlist.provider ? group : {
          ...group,
          playlists: name === undefined
            ? group.playlists.filter(item => item.id !== id)
            : group.playlists.map(item => item.id === id ? { ...item, name: name.trim() } : item),
        });
        currentGroups.current = next;
        return next;
      });
      if (name === undefined) {
        const { [id]: _, ...rest } = currentContents.current;
        currentContents.current = rest;
        setContents(rest);
      } else void load({ ...playlist, name: name.trim() }, "force");
      return true;
    } catch (reason) {
      setError(`${musicProviderName(playlist.provider)}: ${message(reason)}`);
      return false;
    } finally {
      mutations.current.delete(id);
      if (alive.current) setBusy(new Set(mutations.current));
    }
  }

  return { groups, playlists, tracks, contents, loading, busy, errors, error, refresh, load, rename: (id: string, name: string) => edit(id, name), deletePlaylist: (id: string) => edit(id), addTrack: (id: string, track: Track) => change(id, track), removeTracks: (id: string, ids: string[]) => change(id, undefined, ids) };
}
