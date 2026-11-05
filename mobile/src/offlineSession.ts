import { createAudioPlayer } from "expo-audio";
import { useEffect } from "react";
import type { Track } from "../../desktop/src/types/music";
import { configureAudioSession } from "./audioSession";
import { notifySession, setOfflineSession, type QueueSnapshot, type SessionView } from "./client";
import { downloadsSnapshot, phoneDownloadUrl } from "./downloads";
import { PHONE_DEVICE_ID, PhonePlayback } from "./phonePlayback";

/**
 * Playback with no server: songs downloaded to this phone, played from its encrypted copies
 * through the native loopback player. It presents the same session shape as the server's
 * core (`client.ts`), so the player, queue and menus work unchanged while offline.
 */
export class OfflineSession {
  private queue: QueueSnapshot = { version: 1, current: null, upcoming: [], history: [], tracks: [] };
  private revision = 0;
  private queueRevision = 0;
  private engine: PhonePlayback;
  private loadedId: string | null = null;
  private endedSource: string | null = null;
  private sampledAt = Date.now();
  private released = false;
  private current: SessionView;

  constructor(private urlFor: (id: string) => string | null, private changed: () => void) {
    this.engine = new PhonePlayback({
      create: source => createAudioPlayer(source, { updateInterval: 250, keepAudioSessionActive: true, allowsExternalPlayback: false }),
      activate: () => configureAudioSession(true),
      mediaUrl: source => source,
      prefetch: () => {},
      metadata: () => {
        const track = this.track();
        return { title: track?.name ?? "Ambra", artist: track?.artist, albumTitle: track?.album, artworkUrl: track?.cover || undefined };
      },
      ownsOutput: () => !this.released,
      transport: (action, details) => { void this.command(action, details).catch(() => {}); },
      changed: () => this.update(),
    });
    this.current = this.build();
  }

  private track(): Track | undefined {
    const id = this.queue.current?.globalTrackId;
    return (this.queue.tracks as Track[] | undefined)?.find(track => track.globalId === id);
  }

  private build(): SessionView {
    const status = this.engine.status();
    return {
      instanceId: "offline",
      revision: this.revision,
      playing: status.isPlaying,
      positionSeconds: status.currentTime,
      duration: status.duration || this.track()?.durationSeconds || 0,
      buffering: status.buffering,
      error: status.error,
      output: { endpointId: "offline", deviceId: PHONE_DEVICE_ID, endpointName: "This phone", deviceName: "This phone (offline)" },
      outputOnline: true,
      loadedSource: status.currentSource,
      queueRevision: this.queueRevision,
      queue: this.queue,
    };
  }

  private update() {
    if (this.released) return;
    const status = this.engine.status();
    this.revision++;
    this.sampledAt = Date.now();
    this.current = this.build();
    this.changed();
    if (status.ended && status.currentSource && status.currentSource !== this.endedSource) {
      this.endedSource = status.currentSource;
      void this.command("next").catch(() => {});
    }
  }

  view = () => this.current;
  /** Seconds since the shown position was true. */
  age = () => (Date.now() - this.sampledAt) / 1000;

  private async load(autoplay: boolean, position = 0) {
    const track = this.track();
    if (!track) { this.engine.release(); this.loadedId = null; this.update(); return; }
    const url = this.urlFor(track.globalId);
    if (!url) throw new Error(`${track.name} isn't downloaded to this phone.`);
    this.loadedId = track.globalId;
    this.endedSource = null;
    await this.engine.execute("load_native_audio", { source: url, positionSeconds: position, autoplay });
  }

  /** Plays songs that aren't downloaded here are left out, since nothing could play them. */
  async change(change: (queue: QueueSnapshot, revision: number) => QueueSnapshot, play: boolean) {
    const next = change(this.queue, this.queueRevision);
    const playable = (item: { globalTrackId: string }) => !!this.urlFor(item.globalTrackId);
    this.queue = {
      ...next,
      current: next.current && playable(next.current) ? next.current : next.upcoming.find(playable) ?? null,
      upcoming: next.upcoming.filter(playable),
    };
    if (this.queue.current && next.current?.globalTrackId !== this.queue.current.globalTrackId) {
      const current = this.queue.current;
      this.queue = { ...this.queue, upcoming: this.queue.upcoming.filter(item => item !== current) };
    }
    this.queueRevision++;
    if (play || this.queue.current?.globalTrackId !== this.loadedId) await this.load(play);
    this.update();
  }

  async command(action: string, details: Record<string, unknown> = {}) {
    if (action === "play" || action === "pause" || action === "toggle") {
      const status = this.engine.status();
      if (!status.currentSource || status.ended) return this.load(action !== "pause");
      const pause = action === "pause" || (action === "toggle" && status.isPlaying);
      await this.engine.execute(pause ? "pause_native_audio" : "play_native_audio", {});
    } else if (action === "seek") {
      await this.engine.execute("seek_native_audio", { positionSeconds: Math.max(0, Number(details.positionSeconds) || 0) });
    } else if (action === "next" || action === "previous") {
      const { current, upcoming, history = [] } = this.queue;
      if (action === "previous" && this.engine.status().currentTime > 3) {
        await this.engine.execute("seek_native_audio", { positionSeconds: 0 });
        return;
      }
      if (action === "next") {
        if (!upcoming.length) { await this.engine.execute("pause_native_audio", {}); return; }
        const played = current ? [...history, { ...current, historyId: `${Date.now()}`, playedAt: new Date().toISOString() }] : history;
        this.queue = { ...this.queue, history: played.slice(-200), current: upcoming[0], upcoming: upcoming.slice(1) };
      } else {
        const last = history.at(-1);
        if (!last) { await this.engine.execute("seek_native_audio", { positionSeconds: 0 }); return; }
        const { historyId: _id, playedAt: _at, ...previous } = last;
        this.queue = { ...this.queue, history: history.slice(0, -1), current: previous, upcoming: current ? [current, ...upcoming] : upcoming };
      }
      this.queueRevision++;
      await this.load(true);
    } else if (action === "volume") {
      await this.engine.execute("set_native_audio_volume", { volume: Number(details.volume) || 0 });
    }
    this.update();
  }

  release() {
    this.released = true;
    this.engine.release();
  }
}


/**
 * While the server is out of reach, songs downloaded here play from this phone alone; the
 * session goes back to the server's as soon as it's reachable again.
 */
export function useOfflineSession(active: boolean) {
  useEffect(() => {
    if (!active || downloadsSnapshot().phone.size === 0) return;
    const session = new OfflineSession(phoneDownloadUrl, notifySession);
    setOfflineSession(session);
    return () => {
      setOfflineSession(null);
      session.release();
    };
  }, [active]);
}
