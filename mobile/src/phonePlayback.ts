import type { AudioMetadata, AudioPlayer, AudioStatus } from "expo-audio";

export const PHONE_DEVICE_ID = "system";
export type PhonePlayer = Pick<AudioPlayer, "playing" | "isLoaded" | "volume" | "currentTime" | "duration" | "play" | "pause" | "seekTo" | "remove" | "setActiveForLockScreen" | "updateLockScreenMetadata"> & {
  addListener(event: "playbackStatusUpdate", callback: (status: AudioStatus) => void): { remove(): void };
};
type Host = {
  create(source: string): PhonePlayer;
  activate(): Promise<void>;
  mediaUrl(source: string): string;
  metadata(): AudioMetadata;
  ownsOutput(): boolean;
  transport(action: string, details?: Record<string, unknown>): void;
  changed(): void;
};

/** Executes the same output protocol as desktop, keeping all queue decisions in the core. */
export class PhonePlayback {
  private player: PhonePlayer | null = null;
  private subscription: { remove(): void } | null = null;
  private loading: AbortController | null = null;
  private native: AudioStatus | null = null;
  private source: string | null = null;
  private error: string | null = null;
  private ended = false;
  private busy = false;
  private intendedPlaying = false;
  private previous: { position: number; at: number; playing: boolean } | null = null;
  private volume = 100;

  constructor(private host: Host) {}

  status() {
    return {
      currentSource: this.source,
      currentTime: this.player?.currentTime ?? 0,
      duration: this.player?.duration ?? 0,
      isPlaying: !this.ended && (this.native?.playing ?? false),
      buffering: !!this.source && !this.error && (this.busy || !this.native?.isLoaded || !!this.native?.isBuffering),
      ended: this.ended,
      error: this.error ?? this.native?.error ?? null,
    };
  }

  private observe(player: PhonePlayer, status: AudioStatus) {
    if (this.player !== player) return;
    const previous = this.previous;
    const at = Date.now();
    this.native = status;
    if (status.didJustFinish) this.ended = true;
    // Lock-screen controls, headphone disconnection and interruptions must also update the core.
    if (!this.busy && this.host.ownsOutput() && status.isLoaded && !status.isBuffering && !status.error && !this.ended && previous) {
      if (status.playing !== previous.playing && status.playing !== this.intendedPlaying) {
        this.intendedPlaying = status.playing;
        this.host.transport(status.playing ? "play" : "pause");
      }
      const expected = previous.position + (previous.playing ? (at - previous.at) / 1000 : 0);
      if (Math.abs(status.currentTime - expected) > 2.5) this.host.transport("seek", { positionSeconds: status.currentTime });
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

  private async load(source: string, position: number, autoplay: boolean) {
    this.release();
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
      player.volume = this.volume / 100;
      this.subscription = player.addListener("playbackStatusUpdate", status => this.observe(player, status));
      await this.ready(player, controller.signal);
      await player.seekTo(Math.max(0, position));
      if (controller.signal.aborted || !this.host.ownsOutput()) throw new Error("Playback was stopped.");
      player.setActiveForLockScreen(true, this.host.metadata(), { showSeekForward: false, showSeekBackward: false, showNextTrack: false, showPreviousTrack: false });
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
    switch (command) {
      case "select_native_audio_device":
        if (args.deviceId !== PHONE_DEVICE_ID) throw new Error("This phone uses its system audio output.");
        await this.host.activate();
        return null;
      case "load_native_audio":
        if (typeof args.source !== "string") throw new Error("The song has no audio source.");
        await this.load(args.source, Number(args.positionSeconds) || 0, args.autoplay === true);
        return null;
      case "play_native_audio":
        if ((this.error || this.native?.error) && this.source) await this.load(this.source, this.player?.currentTime ?? 0, true);
        else { this.ended = false; this.intendedPlaying = true; this.player?.play(); }
        return null;
      case "pause_native_audio":
        this.intendedPlaying = false;
        this.player?.pause();
        return null;
      case "seek_native_audio": {
        const position = Number(args.positionSeconds);
        if (!Number.isFinite(position) || position < 0) throw new Error("Invalid playback position.");
        this.busy = true;
        this.ended = false;
        try { await this.player?.seekTo(position); } finally { this.busy = false; this.previous = null; }
        return null;
      }
      // The core advances after our 'ended' report; no second player can advance the queue itself.
      case "queue_native_audio":
      case "warm_native_audio":
        return null;
      case "set_native_audio_volume":
        this.volume = Math.min(100, Math.max(0, Number(args.volume) || 0));
        if (this.player) this.player.volume = this.volume / 100;
        return null;
      case "native_audio_volume": return this.volume;
      case "native_audio_settings": return { version: 1, selectedOutputId: PHONE_DEVICE_ID, presets: [], normalization: "off", normalizationTargetLufs: -18, outputs: [{ id: PHONE_DEVICE_ID, name: "Phone", enabled: true, volume: this.volume, exclusiveMode: false, resyncDelayMs: 0, presetId: null }] };
      default: throw new Error("This audio setting isn't available on the phone.");
    }
  }

  updateMetadata() { this.player?.updateLockScreenMetadata(this.host.metadata()); }

  release() {
    this.loading?.abort();
    this.loading = null;
    this.subscription?.remove();
    this.subscription = null;
    const player = this.player;
    this.player = null;
    this.source = null;
    this.native = null;
    this.error = null;
    this.ended = false;
    this.busy = false;
    this.previous = null;
    this.intendedPlaying = false;
    if (player) {
      player.pause();
      player.setActiveForLockScreen(false);
      player.remove();
    }
  }
}
