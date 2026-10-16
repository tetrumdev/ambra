import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { serviceAuthStatus, type StreamingProvider } from "../api/server";
import { changeServicePlaylist, servicePlaylistContents, servicePlaylists, type ServicePlaylistContents } from "../api/playlists";
import type { Playlist, Track } from "../types/music";
import { musicProviderName } from "../utils/musicProviderName";

export type PlaylistServiceGroup = {
  provider: StreamingProvider;
  playlists: Playlist[];
  error: string | null;
};

const providers: StreamingProvider[] = ["spotify", "qobuz", "tidal"];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const playlistId = (provider: StreamingProvider, id: string) => `service:${provider}:${id}`;

export function useServicePlaylists(selectedId: string | null, enabled: boolean) {
  const [groups, setGroups] = useState<PlaylistServiceGroup[]>([]);
  const [contents, setContents] = useState<Record<string, ServicePlaylistContents>>({});
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

  const load = useCallback((playlist: Playlist, force = false): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (!playlist.provider || !playlist.remoteId) return Promise.resolve();
    const existing = requests.current.get(playlist.id);
    if (existing && !force) return existing.promise;
    existing?.controller.abort();
    const controller = new AbortController();
    setLoading(current => new Set(current).add(playlist.id));
    const promise = servicePlaylistContents(playlist.provider, playlist.remoteId, AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]))
      .then(result => {
        if (!alive.current || controller.signal.aborted) return;
        currentContents.current = { ...currentContents.current, [playlist.id]: result };
        setContents(currentContents.current);
        setErrors(current => { const next = { ...current }; delete next[playlist.id]; return next; });
      })
      .catch(reason => {
        if (!alive.current || controller.signal.aborted) return;
        setErrors(current => ({ ...current, [playlist.id]: message(reason) }));
      })
      .finally(() => {
        if (requests.current.get(playlist.id)?.controller !== controller) return;
        requests.current.delete(playlist.id);
        if (alive.current) setLoading(current => { const next = new Set(current); next.delete(playlist.id); return next; });
      });
    requests.current.set(playlist.id, { controller, promise });
    return promise;
  }, [enabled]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) return;
    try {
      const connected = await serviceAuthStatus();
      await Promise.all(providers.filter(provider => connected[provider]).map(async provider => {
        try {
          const remote = await servicePlaylists(provider, signal);
          if (!alive.current || signal?.aborted) return;
          const playlists: Playlist[] = remote.map(playlist => ({ ...playlist, id: playlistId(provider, playlist.id), remoteId: playlist.id, provider, trackIds: [] }));
          setGroups(current => {
            const next = [...current.filter(group => group.provider !== provider), { provider, playlists, error: null }];
            currentGroups.current = next;
            return next;
          });
          const active = playlists.find(playlist => playlist.id === selection.current);
          if (active && !mutations.current.has(active.id)) void load(active);
        } catch (reason) {
          if (!alive.current || signal?.aborted) return;
          setGroups(current => {
            const old = current.find(group => group.provider === provider);
            const next = [...current.filter(group => group.provider !== provider), { provider, playlists: old?.playlists ?? [], error: message(reason) }];
            currentGroups.current = next;
            return next;
          });
        }
      }));
      if (!alive.current || signal?.aborted) return;
      setGroups(current => current.filter(group => connected[group.provider]));
      setError(null);
    } catch (reason) {
      if (alive.current && !signal?.aborted) setError(`Could not refresh service playlists. ${message(reason)}`);
    }
  }, [load, enabled]);

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
  }, [refresh, enabled]);

  useEffect(() => {
    const playlist = currentGroups.current.flatMap(group => group.playlists).find(playlist => playlist.id === selectedId);
    if (playlist) void load(playlist);
  }, [selectedId, load]);

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
      await load(playlist, true);
      return true;
    } catch (reason) {
      setError(`${musicProviderName(playlist.provider)}: ${message(reason)}`);
      void load(playlist, true);
      throw reason;
    } finally {
      mutations.current.delete(id);
      if (alive.current) setBusy(new Set(mutations.current));
    }
  }

  return { groups, playlists, tracks, contents, loading, busy, errors, error, refresh, load, addTrack: (id: string, track: Track) => change(id, track), removeTracks: (id: string, ids: string[]) => change(id, undefined, ids) };
}
