import type { SessionView } from "./client";

export type ActivitySnapshot = {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  output: string;
  artwork: string;
  playing: boolean;
  position: number;
  duration: number;
  updatedAt: number;
  startAt: number;
  endAt: number;
};

/** The OS can advance its timer while JavaScript sleeps; pauses and buffering hold it. */
export function activitySnapshot(view: SessionView | null, ageSeconds: number, now: number): ActivitySnapshot | null {
  if (!view?.output || !view.outputOnline || ageSeconds > 90) return null;
  const track = view.queue.tracks?.find(item => item.globalId === view.queue.current?.globalTrackId);
  if (!track) return null;
  const playing = view.playing && !view.buffering;
  const duration = Math.max(0, view.duration || track.durationSeconds || 0);
  const elapsed = Math.max(0, view.positionSeconds + (playing ? Math.max(0, ageSeconds) : 0));
  const position = duration > 0 ? Math.min(duration, elapsed) : elapsed;
  const startAt = now - position * 1000;
  return {
    trackId: track.globalId, title: track.name, artist: track.artist, album: track.album,
    output: view.output.deviceName || view.output.endpointName,
    artwork: "", playing, position, duration, updatedAt: now, startAt,
    endAt: startAt + Math.max(duration, position + 1) * 1000,
  };
}

export interface ActivityHandle {
  getId?(): string;
  update(props: ActivitySnapshot, staleDate?: Date): Promise<void>;
  end(policy: "immediate"): Promise<void>;
}
export interface ActivityHost {
  recover(): ActivityHandle[];
  start(props: ActivitySnapshot, url: string, staleDate: Date): ActivityHandle;
  foreground(): boolean;
  keepAlive(active: boolean): Promise<void>;
  isActive?(activity: ActivityHandle): boolean;
}

/** Serialize native work, coalescing rapid skips and ensuring unpair/stop wins over an in-flight update. */
export class ActivitySession {
  private handle: ActivityHandle | null = null;
  private recovered = false;
  private revision = 0;
  private dismissed = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private host: ActivityHost) {}

  sync(props: ActivitySnapshot | null): Promise<void> {
    const revision = ++this.revision;
    this.tail = this.tail.catch(() => {}).then(() => this.apply(props, revision));
    return this.tail;
  }

  private async apply(props: ActivitySnapshot | null, revision: number) {
    if (revision !== this.revision) return;
    try {
      if (!this.recovered) {
        const [first, ...duplicates] = this.host.recover();
        this.handle = first ?? null;
        this.recovered = true;
        await Promise.all(duplicates.map(activity => activity.end("immediate")));
      }
      if (revision !== this.revision) return;
      if (!props) {
        await this.host.keepAlive(false);
        if (this.handle) await this.handle.end("immediate");
        this.handle = null;
        this.dismissed = false;
        return;
      }
      if (this.handle && this.host.isActive && !this.host.isActive(this.handle)) {
        // A dismissal or ActivityKit's lifetime limit also releases the background lease.
        this.handle = null;
        this.dismissed = true;
        await this.host.keepAlive(false);
        return;
      }
      if (this.dismissed && !this.host.foreground()) return;
      this.dismissed = false;
      const stale = new Date(props.updatedAt + 90_000);
      if (!this.handle) {
        // ActivityKit only permits starting a local activity while the app is foregrounded.
        if (!this.host.foreground()) return;
        this.handle = this.host.start(props, "ambra://player", stale);
      }
      await this.host.keepAlive(true);
      if (revision === this.revision) await this.handle.update(props, stale);
    } catch (error) {
      await this.host.keepAlive(false);
      throw error;
    }
  }
}
