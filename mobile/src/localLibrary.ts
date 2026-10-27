import type { AudioMetadata } from "expo-audio";
import { PhonePlayback, type PhonePlayer } from "./phonePlayback";

export type LocalTrack = { id: string; uri: string; name: string; artist: string; album: string; durationSeconds: number };
export type LocalPlaylist = { id: string; name: string; trackIds: string[] };
export type LocalLibrary = {
  version: 1; tracks: LocalTrack[]; playlists: LocalPlaylist[]; queue: string[]; index: number;
  positionSeconds: number; history: { trackId: string; playedAt: number }[]; volume: number;
};
export const emptyLocalLibrary = (): LocalLibrary => ({ version: 1, tracks: [], playlists: [], queue: [], index: 0, positionSeconds: 0, history: [], volume: 100 });
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Reject corrupt state; callers retain both durable journal slots for recovery. */
export function parseLocalLibrary(raw: string): LocalLibrary {
  const value = JSON.parse(raw) as LocalLibrary;
  if (value?.version !== 1 || !Array.isArray(value.tracks) || !Array.isArray(value.playlists) || !Array.isArray(value.queue)
    || !Array.isArray(value.history) || !finite(value.positionSeconds) || !finite(value.volume) || value.volume > 100
    || !Number.isSafeInteger(value.index) || value.index < 0 || (value.queue.length > 0 && value.index >= value.queue.length)) throw new Error("Invalid local music state.");
  const ids = new Set<string>();
  for (const track of value.tracks) {
    if (!track || typeof track.id !== "string" || !track.id || ids.has(track.id) || !track.uri?.startsWith("file://")
      || ![track.name, track.artist, track.album].every(item => typeof item === "string") || !finite(track.durationSeconds)) throw new Error("Invalid local track.");
    ids.add(track.id);
  }
  const playlistIds = new Set<string>();
  for (const playlist of value.playlists) {
    if (!playlist || typeof playlist.id !== "string" || !playlist.id || playlistIds.has(playlist.id) || typeof playlist.name !== "string"
      || !playlist.name.trim() || !Array.isArray(playlist.trackIds) || !playlist.trackIds.every(id => ids.has(id))) throw new Error("Invalid local playlist.");
    playlistIds.add(playlist.id);
  }
  if (!value.queue.every(id => ids.has(id)) || !value.history.every(item => item && ids.has(item.trackId) && finite(item.playedAt))) throw new Error("Invalid local queue or history.");
  return value;
}

type Host = {
  save(state: LocalLibrary): Promise<void>;
  create(source: string): PhonePlayer;
  activate(): Promise<void>;
};
export type LocalView = { library: LocalLibrary; playing: boolean; buffering: boolean; position: number; duration: number; error: string | null };

/** Device-only queue authority using the same Expo audio engine as shared playback. No network calls. */
export class LocalMusic {
  private listeners = new Set<() => void>();
  private engine: PhonePlayback;
  private current: LocalView;
  private saves: Promise<void> = Promise.resolve();
  private operations: Promise<void> = Promise.resolve();
  private endedSource: string | null = null;
  private released = false;
  private savedPosition = -1;
  constructor(library: LocalLibrary, private host: Host) {
    this.current = { library, playing: false, buffering: false, position: library.positionSeconds, duration: library.tracks.find(track => track.id === library.queue[library.index])?.durationSeconds ?? 0, error: null };
    this.engine = new PhonePlayback({
      create: host.create, activate: host.activate,
      ownsOutput: () => !this.released,
      mediaUrl: source => {
        if (!source.startsWith("file://") || !this.current.library.tracks.some(track => track.uri === source)) throw new Error("Choose an imported local file.");
        return source;
      },
      metadata: (): AudioMetadata => ({ title: this.track()?.name ?? "Ambra", artist: this.track()?.artist, albumTitle: this.track()?.album }),
      transport: (action, details) => { void this.command(action, details).catch(() => {}); },
      changed: () => this.changed(),
    });
    void this.engine.execute("set_native_audio_volume", { volume: library.volume });
  }
  snapshot = () => this.current;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  track = () => this.current?.library.tracks.find(track => track.id === this.current.library.queue[this.current.library.index]);
  private publish(change: Partial<LocalView>) { this.current = { ...this.current, ...change }; for (const listener of this.listeners) listener(); }
  private persist() {
    const state = this.current.library;
    const save = this.saves.catch(() => {}).then(() => this.host.save(state));
    this.saves = save.catch(reason => { this.publish({ error: `Local changes could not be saved. ${String(reason)}` }); });
    return save;
  }
  async edit(transform: (state: LocalLibrary) => LocalLibrary) {
    const next = transform(this.current.library);
    parseLocalLibrary(JSON.stringify(next));
    this.publish({ library: next });
    await this.persist();
  }
  private changed() {
    if (this.released) return;
    const status = this.engine.status();
    this.publish({ playing: status.isPlaying, buffering: status.buffering, position: status.currentTime,
      duration: status.duration || this.track()?.durationSeconds || 0, error: status.error });
    const bucket = Math.floor(status.currentTime / 5);
    if (status.currentSource && bucket !== this.savedPosition) {
      this.savedPosition = bucket;
      const library = { ...this.current.library, positionSeconds: status.currentTime };
      const track = this.track();
      if (track && status.duration > 0 && track.durationSeconds !== status.duration) library.tracks = library.tracks.map(item => item.id === track.id ? { ...item, durationSeconds: status.duration } : item);
      this.publish({ library });
      void this.persist().catch(() => {});
    }
    if (status.ended && status.currentSource !== this.endedSource) {
      this.endedSource = status.currentSource;
      void this.command("next").catch(() => {});
    }
  }
  private async load(autoplay: boolean, position = 0) {
    const track = this.track();
    if (!track) return;
    this.endedSource = null;
    this.savedPosition = -1;
    await this.engine.execute("load_native_audio", { source: track.uri, positionSeconds: position, autoplay });
    if (autoplay) await this.edit(state => ({ ...state, history: [...state.history, { trackId: track.id, playedAt: Date.now() }].slice(-1000) }));
  }
  async play(id: string, queue = this.current.library.tracks.map(track => track.id)) {
    return this.enqueue(async () => {
      if (!queue.includes(id)) throw new Error("Track is not in this queue.");
      await this.edit(state => ({ ...state, queue, index: queue.indexOf(id), positionSeconds: 0 }));
      await this.load(true);
    });
  }
  private enqueue(work: () => Promise<void>) {
    const operation = this.operations.catch(() => {}).then(async () => { if (!this.released) await work(); });
    this.operations = operation.catch(reason => { this.publish({ error: String(reason), buffering: false }); });
    return operation;
  }
  command(action: string, details: Record<string, unknown> = {}) {
    return this.enqueue(async () => {
      const state = this.current.library;
      if (action === "next" || action === "previous") {
        const index = state.index + (action === "next" ? 1 : -1);
        if (index < 0 || index >= state.queue.length) { await this.engine.execute("pause_native_audio", {}); return; }
        await this.edit(current => ({ ...current, index, positionSeconds: 0 }));
        await this.load(true);
      } else if (action === "seek") {
        const position = Math.min(this.current.duration || Infinity, Math.max(0, Number(details.positionSeconds) || 0));
        await this.engine.execute("seek_native_audio", { positionSeconds: position });
        this.publish({ position });
        await this.edit(current => ({ ...current, positionSeconds: position }));
      } else if (action === "volume") {
        const volume = Math.max(0, Math.min(100, Number(details.volume) || 0));
        await this.engine.execute("set_native_audio_volume", { volume });
        await this.edit(current => ({ ...current, volume }));
      } else if (action === "toggle" || action === "play" || action === "pause") {
        if (!this.engine.status().currentSource || this.engine.status().ended) await this.load(action !== "pause", this.current.duration > 0 && state.positionSeconds >= this.current.duration ? 0 : state.positionSeconds);
        else await this.engine.execute(action === "pause" || (action === "toggle" && this.current.playing) ? "pause_native_audio" : "play_native_audio", {});
      }
    });
  }
  removeTrack(id: string) {
    return this.enqueue(async () => {
      const state = this.current.library;
      const playing = this.track()?.id === id;
      if (playing) this.engine.release();
      await this.edit(current => {
        const queue = current.queue.filter(trackId => trackId !== id);
        const before = current.queue.slice(0, current.index).filter(trackId => trackId === id).length;
        const index = Math.max(0, Math.min(current.index - before, queue.length - 1));
        return { ...current, tracks: current.tracks.filter(track => track.id !== id),
          playlists: current.playlists.map(playlist => ({ ...playlist, trackIds: playlist.trackIds.filter(trackId => trackId !== id) })),
          queue, index, positionSeconds: playing ? 0 : state.positionSeconds,
          history: current.history.filter(entry => entry.trackId !== id) };
      });
      if (playing) this.publish({ playing: false, position: 0, duration: this.track()?.durationSeconds ?? 0 });
    });
  }
  async release() {
    this.released = true;
    const status = this.engine.status();
    if (status.currentSource) this.publish({ library: { ...this.current.library, positionSeconds: status.currentTime } });
    this.engine.release();
    await this.persist();
  }
}
