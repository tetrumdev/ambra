import type { AudioEvents, AudioMetadata, AudioPlayer, AudioStatus } from "expo-audio";
import { RATE_HOLD_MS, REALIGN_ABOVE, SyncTrim, carriedOver, positionAt, type SyncAnchor } from "./phoneSync";

export const PHONE_DEVICE_ID = "system";
export type PhonePlayer = Pick<AudioPlayer, "playing" | "isLoaded" | "volume" | "currentTime" | "duration" | "play" | "pause" | "seekTo" | "remove" | "setActiveForLockScreen" | "updateLockScreenMetadata"> & {
  /** Missing from players that never join a synced group. */
  setPlaybackRate?: AudioPlayer["setPlaybackRate"];
  addListener<Event extends "playbackStatusUpdate" | "remoteCommand">(event: Event, callback: AudioEvents[Event]): { remove(): void };
};
type Host = {
  create(source: string): PhonePlayer;
  activate(): Promise<void>;
  mediaUrl(source: string): string;
  /** Starts downloading a song so it plays through a network change. */
  prefetch(source: string): void;
  metadata(): AudioMetadata;
  ownsOutput(): boolean;
  transport(action: string, details?: Record<string, unknown>): void;
  changed(): void;
  /** The server's clock less this phone's monotonic one (`performance.now`), when known. */
  serverOffset?(): number | null;
  /** How long sound takes from the player to the ear: the listener's setting for this phone. */
  outputLatencyMs?(): number;
  /** The system volume (0 to 1), as the phone's buttons set it; without one, the player's own is used. */
  systemVolume?(): number;
  setSystemVolume?(volume: number): void;
};

/** Between play() and the first sound, as near as can be told; corrected while playing. */
const START_LATENCY_MS = 60;
/** How often a playing phone in a group checks itself against the group. */
const SYNC_CHECK_MS = 200;
/** Seeks to rejoin the group are at least this far apart, so one can land before the next. */
const REALIGN_COOLDOWN_MS = 1500;
/** Learned per seek: how long a seek takes to take effect. */
const DEFAULT_SEEK_LATENCY_MS = 80;

type Sync = {
  epoch: number;
  /** None while held for the group's start. */
  anchor: SyncAnchor | null;
  /** Loaded and in place for the start. */
  ready: boolean;
  trim: SyncTrim;
  rate: number;
  /** When the rate last changed. */
  rateAt: number;
  startTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * Executes the same output protocol as desktop, keeping all queue decisions in the core.
 * Every seek is exact (zero tolerance): by default iOS may land wherever is cheapest in the
 * file while reporting the time asked for, leaving the phone audibly off from where it thinks.
 */
export class PhonePlayback {
  private player: PhonePlayer | null = null;
  private subscription: { remove(): void } | null = null;
  private remoteSubscription: { remove(): void } | null = null;
  private loading: AbortController | null = null;
  private native: AudioStatus | null = null;
  private source: string | null = null;
  /** The song the core queued after this one; played straight away if this one ends. */
  private next: string | null = null;
  private error: string | null = null;
  private ended = false;
  private busy = false;
  private intendedPlaying = false;
  /**
   * Paused for a skip until the core answers with the next song (or a seek, for a previous
   * that restarts). A skip lost to latency then can't leave the old song playing on.
   */
  private skipping = false;
  private previous: { position: number; at: number; playing: boolean } | null = null;
  private volume = 100;
  private metadataSignature = "";
  /**
   * The plays, pauses and seeks made on this phone (its own controls, the lock screen,
   * headphones): `seq` counts them, `playing` is what the latest left. Reports carry it and
   * the core takes it on, so these work without waiting on the server.
   */
  private control = { seq: 0, playing: false };
  /** Playing in step with other outputs, as one of a synced group. */
  private sync: Sync | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private seekLatencyMs = DEFAULT_SEEK_LATENCY_MS;
  private realigning = false;
  private realignedAt = -Infinity;
  /** The player's position at the last check, to tell playing from stalled. */
  private progress: { time: number; at: number } | null = null;

  constructor(private host: Host) {}

  /** The system volume when this phone has one in reach (its buttons may have moved it), else the player's. */
  private currentVolume() {
    const system = this.host.systemVolume?.();
    return system === undefined || !Number.isFinite(system) ? this.volume : Math.round(system * 100);
  }

  /** Whether this phone is in a synced group, so it keeps its clock close to the server's. */
  syncing() { return this.sync !== null; }

  /** Held for a group's start: load or seek in place, paused, and say when ready. */
  private hold(epoch: number) {
    this.clearSync();
    this.sync = { epoch, anchor: null, ready: false, trim: new SyncTrim(), rate: 1, rateAt: 0, startTimer: null };
    // About to play with the group: shown as playing, not paused.
    this.intendedPlaying = true;
  }

  private held(epoch: number) {
    if (this.sync?.epoch !== epoch || this.sync.anchor) return;
    this.player?.pause();
    this.sync.ready = true;
    this.host.changed();
  }

  /** Plays alone again: no timeline, normal speed. */
  private clearSync() {
    if (this.sync?.startTimer) clearTimeout(this.sync.startTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    if (this.sync && this.sync.rate !== 1) this.player?.setPlaybackRate?.(1, "high");
    this.sync = null;
  }

  /** The group's start: song position `position` is heard at `atServerMs`. */
  private startSync(args: Record<string, unknown>) {
    const sync = this.sync;
    const epoch = Number(args.epoch);
    const position = Number(args.positionSeconds);
    const atServerMs = Number(args.atServerMs);
    if (!sync || sync.epoch !== epoch || !Number.isFinite(position) || !Number.isFinite(atServerMs)) return;
    const offset = (this.host.serverOffset?.() ?? null);
    const sent = Number(args.sentAtServerMs);
    // Before the clocks are compared, when the server sent it stands for now.
    const atMs = offset !== null ? atServerMs - offset : performance.now() + (Number.isFinite(sent) ? atServerMs - sent : 0);
    // Already playing with the group: the leading output's timeline moved (a song change), so
    // only the timeline changes; the checks below bring the phone onto it.
    if (sync.anchor && !sync.startTimer && this.player?.playing) {
      sync.anchor = { atMs, position };
      sync.trim.reset();
      this.host.changed();
      return;
    }
    sync.anchor = { atMs, position };
    sync.ready = false;
    sync.trim.reset();
    const player = this.player;
    if (!player) return;
    const latency = (this.host.outputLatencyMs?.() ?? 0);
    // play() goes out early by the time sound takes to start and to reach the ear.
    const wait = atMs - latency - START_LATENCY_MS - performance.now();
    const begin = () => {
      if (this.sync !== sync || this.player !== player) return;
      sync.startTimer = null;
      this.intendedPlaying = true;
      this.ended = false;
      player.play();
      this.host.changed();
    };
    if (wait > 0) {
      // In place now, so starting is only a play().
      if (Math.abs(player.currentTime - position) > 0.02) void player.seekTo(position, 0, 0);
      sync.startTimer = setTimeout(begin, wait);
    } else {
      // Late: start from where the group already is.
      void this.realign(player, sync).then(begin);
    }
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => this.keepInStep(), SYNC_CHECK_MS);
  }

  /** Seeks to where the group is, allowing for the seek itself and the way to the ear. */
  private async realign(player: PhonePlayer, sync: Sync) {
    if (!sync.anchor || this.realigning) return;
    this.realigning = true;
    try {
      const latency = (this.host.outputLatencyMs?.() ?? 0);
      const target = positionAt(sync.anchor, performance.now() + this.seekLatencyMs + latency);
      const asked = performance.now();
      await player.seekTo(Math.max(0, target), 0, 0);
      this.progress = null;
      // Learn how long seeks really take here, so the next one lands closer.
      const took = performance.now() - asked;
      this.seekLatencyMs = Math.min(400, Math.max(20, this.seekLatencyMs * 0.7 + took * 0.3));
      sync.trim.reset();
    } catch {
      // The next check tries again.
    } finally {
      this.realigning = false;
    }
  }

  /** Compares what the phone plays with the group's timeline and corrects it. */
  private keepInStep() {
    const sync = this.sync;
    const player = this.player;
    if (!sync?.anchor || !player || sync.startTimer || this.busy || this.realigning || this.loading) return;
    // Stopped without being asked while the group plays: start again and rejoin it.
    if (!player.playing) {
      const now = performance.now();
      if (this.intendedPlaying && !this.ended && this.native?.isLoaded && !this.native.isBuffering && now - this.realignedAt >= REALIGN_COOLDOWN_MS) {
        this.realignedAt = now;
        player.play();
        void this.realign(player, sync);
      }
      return;
    }
    const now = performance.now();
    const time = player.currentTime;
    // Only a phone that is really playing can be measured: while it buffers its position
    // stands still, and correcting then would only seek again and again.
    const last = this.progress;
    this.progress = { time, at: now };
    const advancing = !!last && now - last.at < SYNC_CHECK_MS * 3 && time - last.time > (now - last.at) / 1000 * 0.5;
    if (!advancing || !this.native?.isLoaded || this.native.isBuffering) {
      sync.trim.reset();
      return;
    }
    const latency = (this.host.outputLatencyMs?.() ?? 0);
    // What reaches the ear now is what the player played `latency` ago.
    const error = time - latency / 1000 - positionAt(sync.anchor, now);
    if (Math.abs(error) > REALIGN_ABOVE) {
      // A seek needs a moment to settle and show where it landed.
      if (now - this.realignedAt < REALIGN_COOLDOWN_MS) return;
      this.realignedAt = now;
      if (sync.rate !== 1) { sync.rate = 1; player.setPlaybackRate?.(1, "high"); }
      void this.realign(player, sync);
      return;
    }
    sync.trim.observe(error, now);
    const rate = sync.trim.rate();
    // Back to normal speed at once; otherwise only every so often, and only for a real change.
    if (rate !== sync.rate && (rate === 1 || now - sync.rateAt >= RATE_HOLD_MS)) {
      sync.rate = rate;
      sync.rateAt = now;
      player.setPlaybackRate?.(rate, "high");
    }
  }

  status() {
    return {
      currentSource: this.source,
      currentTime: this.player?.currentTime ?? 0,
      duration: this.player?.duration ?? 0,
      isPlaying: !this.ended && (this.native?.playing ?? false),
      buffering: !!this.source && !this.error && (this.busy || this.skipping || !this.native?.isLoaded || !!this.native?.isBuffering || (!!this.sync && (!this.sync.anchor || !!this.sync.startTimer))),
      ended: this.ended,
      error: this.error ?? this.native?.error ?? null,
      ...(this.control.seq > 0 ? { control: { ...this.control } } : {}),
      // Can play in step with other outputs (session.rs `syncV1`), following the leading
      // output's timeline across song changes (`anchorFollowV1`).
      syncV1: true,
      anchorFollowV1: true,
      ...this.syncStatus(),
    };
  }

  private syncStatus(): { syncReady?: number | null; syncResyncDelayMs?: number; resyncDelayMs?: number; syncAnchor?: { atServerMs: number; positionSeconds: number }; syncErrorMs?: number } {
    const sync = this.sync;
    if (!sync) return {};
    const offset = (this.host.serverOffset?.() ?? null);
    const error = sync.trim.error();
    return {
      syncReady: sync.ready && !sync.anchor ? sync.epoch : null,
      // Lead time the group's start must leave: this phone starts early by its start-up and
      // speaker delays.
      syncResyncDelayMs: Math.max(0, Math.round((this.host.outputLatencyMs?.() ?? 0) + START_LATENCY_MS)),
      resyncDelayMs: 0,
      ...(sync.anchor && offset !== null ? { syncAnchor: { atServerMs: sync.anchor.atMs + offset, positionSeconds: sync.anchor.position } } : {}),
      ...(error !== null ? { syncErrorMs: error * 1000 } : {}),
    };
  }

  /** Whether this phone means to be playing, as opposed to loading or skipping while paused. */
  wantsToPlay() { return this.intendedPlaying; }

  /** Whether `source` is loaded here and ready to be played, paused or sought by this phone. */
  controls(source: string | null | undefined) {
    return !!source && source === this.source && !!this.player && !this.loading && !this.error && !this.native?.error;
  }

  private changedHere(playing: boolean) {
    this.control = { seq: this.control.seq + 1, playing };
  }

  /** A play, pause or seek decided by the core before it heard of this phone's latest own one. */
  private overruled(args: Record<string, unknown>) {
    return typeof args.control === "number" && args.control < this.control.seq;
  }

  /** Pauses the current song while a skip goes to the core; false if nothing plays here. */
  holdForSkip() {
    if (!this.player || this.loading) return false;
    this.skipping = true;
    this.player.pause();
    this.host.changed();
    return true;
  }

  /**
   * Ends a skip hold the core settled without a new song or seek: `resume` when it had nothing
   * to skip to, otherwise (the skip never reached it) the pause becomes this phone's own.
   */
  endSkip(resume: boolean) {
    if (!this.skipping || !this.player) return;
    this.skipping = false;
    if (resume) {
      if (this.intendedPlaying) this.player.play();
    } else {
      this.intendedPlaying = false;
      this.changedHere(false);
    }
    this.host.changed();
  }

  /** Plays, pauses or seeks at once, for the listener holding this phone. */
  async local(action: "play" | "pause" | "seek", positionSeconds?: number) {
    const player = this.player;
    if (!player) return;
    this.clearSync();
    const held = this.skipping;
    this.skipping = false;
    if (action === "seek") {
      const position = Number(positionSeconds);
      if (!Number.isFinite(position) || position < 0) return;
      this.changedHere(this.intendedPlaying);
      this.busy = true;
      this.ended = false;
      this.host.changed();
      try { await player.seekTo(position, 0, 0); } finally { this.busy = false; this.previous = null; this.host.changed(); }
      if (held && this.player === player && this.intendedPlaying) player.play();
      return;
    }
    const playing = action === "play";
    this.changedHere(playing);
    this.intendedPlaying = playing;
    if (playing) { this.ended = false; player.play(); } else player.pause();
    this.host.changed();
  }

  private observe(player: PhonePlayer, status: AudioStatus) {
    if (this.player !== player) return;
    const previous = this.previous;
    const at = Date.now();
    this.native = status;
    if (status.didJustFinish) {
      // Like desktop's engine, move on to the queued song by itself. The core advances when it
      // sees the report, and the song keeps going even while the server is out of reach.
      const next = this.next;
      if (next && next !== this.source && this.host.ownsOutput()) {
        this.next = null;
        const sync = this.sync;
        if (sync?.anchor) {
          sync.anchor = carriedOver(sync.anchor, player.duration || status.duration || status.currentTime);
          sync.trim.reset();
          // Loading took the phone off the timeline: it rejoins as soon as the next song plays.
          void this.load(next, 0, true, true).then(() => { if (this.sync === sync && this.player) void this.realign(this.player, sync); }).catch(() => {});
          return;
        }
        void this.load(next, 0, true).catch(() => {});
        return;
      }
      this.ended = true;
    }
    // Lock-screen controls, headphone disconnection and interruptions are this phone's own
    // changes too; the core takes them on from the next report.
    // In a group, a pause the player made by itself (a stall, an interruption) isn't the
    // listener's: the phone plays on with the group instead of adopting it.
    if (!this.busy && !this.skipping && !this.sync && this.host.ownsOutput() && status.isLoaded && !status.isBuffering && !status.error && !this.ended && previous) {
      if (status.playing !== previous.playing && status.playing !== this.intendedPlaying) {
        this.intendedPlaying = status.playing;
        this.changedHere(status.playing);
      }
      const expected = previous.position + (previous.playing ? (at - previous.at) / 1000 : 0);
      if (Math.abs(status.currentTime - expected) > 2.5) this.changedHere(this.intendedPlaying);
    }
    this.previous = { position: status.currentTime, at, playing: status.playing };
    this.host.changed();
  }

  private async ready(player: PhonePlayer, signal: AbortSignal) {
    const started = Date.now();
    while (!player.isLoaded) {
      if (signal.aborted || this.player !== player) throw new Error("Playback was stopped.");
      if (this.native?.error) throw new Error(this.native.error);
      if (Date.now() - started > 10_000) throw new Error("The song took too long to load on this phone. Please try again.");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (signal.aborted || this.player !== player) throw new Error("Playback was stopped.");
  }

  private async load(source: string, position: number, autoplay: boolean, keepSync = false) {
    const sync = this.sync;
    this.release();
    if (keepSync && sync) {
      // A new player plays at normal speed; the group's timeline carries on.
      this.sync = sync;
      sync.rate = 1;
      sync.trim.reset();
      this.syncTimer = setInterval(() => this.keepInStep(), SYNC_CHECK_MS);
    }
    const controller = new AbortController();
    this.loading = controller;
    this.source = source;
    this.busy = true;
    this.intendedPlaying = autoplay;
    try {
      const url = this.host.mediaUrl(source);
      await this.host.activate();
      if (controller.signal.aborted || !this.host.ownsOutput()) throw new Error("This phone is no longer the selected output.");
      const player = this.host.create(url);
      this.player = player;
      // With the system volume in charge, the player itself stays at full.
      player.volume = this.host.setSystemVolume ? 1 : this.volume / 100;
      this.subscription = player.addListener("playbackStatusUpdate", status => this.observe(player, status));
      this.remoteSubscription = player.addListener("remoteCommand", event => {
        if (this.player === player && this.host.ownsOutput() && (event.action === "next" || event.action === "previous")) {
          this.host.transport(event.action);
        }
      });
      await this.ready(player, controller.signal);
      await player.seekTo(Math.max(0, position), 0, 0);
      if (controller.signal.aborted || !this.host.ownsOutput()) throw new Error("Playback was stopped.");
      const metadata = this.host.metadata();
      player.setActiveForLockScreen(true, metadata, { showSeekForward: false, showSeekBackward: false, showNextTrack: true, showPreviousTrack: true });
      this.metadataSignature = JSON.stringify(metadata);
      if (autoplay) player.play();
    } catch (reason) {
      if (!controller.signal.aborted) {
        this.error = reason instanceof Error ? reason.message : "Couldn't play this song on your phone.";
        this.player?.pause();
      }
      throw reason;
    } finally {
      if (this.loading === controller) { this.busy = false; this.loading = null; this.host.changed(); }
    }
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    // A synced group's load, seek or play is held for the group's start; any other plays alone.
    const epoch = (args.sync as { epoch?: unknown } | null | undefined)?.epoch;
    const holding = typeof epoch === "number" && !this.overruled(args) && ["load_native_audio", "seek_native_audio", "play_native_audio"].includes(command);
    if (holding) this.hold(epoch);
    else if (["load_native_audio", "seek_native_audio", "play_native_audio", "pause_native_audio"].includes(command)) this.clearSync();
    const result = await this.run(command, args, holding);
    if (holding) this.held(epoch);
    return result;
  }

  private async run(command: string, args: Record<string, unknown>, holding: boolean): Promise<unknown> {
    switch (command) {
      case "sync_native_audio":
        this.startSync(args);
        return null;
      case "select_native_audio_device":
        if (args.deviceId !== PHONE_DEVICE_ID) throw new Error("This phone uses its system audio output.");
        await this.host.activate();
        return null;
      case "load_native_audio": {
        if (typeof args.source !== "string") throw new Error("The song has no audio source.");
        const next = typeof args.nextSource === "string" ? args.nextSource : null;
        if (next) this.host.prefetch(next);
        // Played or paused as this phone last left it, if that came after the core decided.
        const autoplay = holding ? false : this.overruled(args) ? this.control.playing : args.autoplay === true;
        await this.load(args.source, Number(args.positionSeconds) || 0, autoplay, holding);
        this.next = next;
        return null;
      }
      case "play_native_audio":
        if (this.overruled(args)) return null;
        this.skipping = false;
        // Held: it plays when the group starts.
        if (holding) return null;
        if ((this.error || this.native?.error) && this.source) await this.load(this.source, this.player?.currentTime ?? 0, true);
        else { this.ended = false; this.intendedPlaying = true; this.player?.play(); }
        return null;
      case "pause_native_audio":
        if (this.overruled(args)) return null;
        this.skipping = false;
        this.intendedPlaying = false;
        this.player?.pause();
        return null;
      case "seek_native_audio": {
        if (this.overruled(args)) return null;
        const position = Number(args.positionSeconds);
        if (!Number.isFinite(position) || position < 0) throw new Error("Invalid playback position.");
        const player = this.player;
        const held = this.skipping;
        this.skipping = false;
        this.busy = true;
        this.ended = false;
        try { await player?.seekTo(position, 0, 0); } finally { this.busy = false; this.previous = null; }
        // A previous that restarts the song arrives as a seek; play on from the start.
        if (!holding && held && player && this.player === player && this.intendedPlaying) player.play();
        return null;
      }
      case "queue_native_audio":
        this.next = typeof args.source === "string" ? args.source : null;
        if (this.next) this.host.prefetch(this.next);
        return null;
      case "warm_native_audio":
        if (typeof args.source === "string") this.host.prefetch(args.source);
        return null;
      case "set_native_audio_volume":
        this.volume = Math.min(100, Math.max(0, Number(args.volume) || 0));
        if (this.host.setSystemVolume) this.host.setSystemVolume(this.volume / 100);
        else if (this.player) this.player.volume = this.volume / 100;
        return null;
      case "native_audio_volume": return this.currentVolume();
      case "native_audio_settings": return { version: 1, selectedOutputId: PHONE_DEVICE_ID, presets: [], normalization: "off", normalizationTargetLufs: -18, outputs: [{ id: PHONE_DEVICE_ID, name: "Phone", enabled: true, volume: this.currentVolume(), exclusiveMode: false, resyncDelayMs: 0, latencyMs: (this.host.outputLatencyMs?.() ?? 0), presetId: null }] };
      default: throw new Error("This audio setting isn't available on the phone.");
    }
  }

  updateMetadata() {
    if (!this.player || this.loading) return;
    const metadata = this.host.metadata();
    const signature = JSON.stringify(metadata);
    // Updating iOS metadata re-registers remote commands; position reports need no refresh.
    if (signature !== this.metadataSignature) {
      this.player.updateLockScreenMetadata(metadata);
      this.metadataSignature = signature;
    }
  }

  release() {
    this.clearSync();
    this.loading?.abort();
    this.loading = null;
    this.subscription?.remove();
    this.subscription = null;
    this.remoteSubscription?.remove();
    this.remoteSubscription = null;
    this.metadataSignature = "";
    const player = this.player;
    this.player = null;
    this.source = null;
    this.next = null;
    this.native = null;
    this.error = null;
    this.ended = false;
    this.busy = false;
    this.previous = null;
    this.intendedPlaying = false;
    this.skipping = false;
    if (player) {
      player.pause();
      player.setActiveForLockScreen(false);
      player.remove();
    }
  }
}
