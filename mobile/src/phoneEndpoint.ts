import { createAudioPlayer } from "expo-audio";
import Constants from "expo-constants";
import { AppState, Platform } from "react-native";
import { configureAudioSession } from "./audioSession";
import { Unpaired, clientId, command, currentTrack, endpointRequest, phoneMediaUrl, refreshSession, sessionView, subscribe } from "./client";
import { PHONE_DEVICE_ID, PhonePlayback } from "./phonePlayback";

export type PhoneEndpointInfo = { id: string; name: string; ready: boolean; error: string | null };
let info: PhoneEndpointInfo | null = null;
const listeners = new Set<() => void>();
export const phoneEndpointInfo = () => info;
export function subscribePhoneEndpoint(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(next: PhoneEndpointInfo | null) { info = next; for (const listener of listeners) listener(); }
type Job = { id: number; command: string; args: Record<string, unknown> };
const instanceId = () => `phone-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The phone reports presence and executes the core's output commands, just as desktop does. */
export function followPhoneOutput() {
  const abort = new AbortController();
  let player: PhonePlayback | null = null;
  let unsubscribe = () => {};
  let foreground: { remove(): void } | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reportTimer: ReturnType<typeof setTimeout> | null = null;

  void clientId().then(async id => {
    if (abort.signal.aborted) return;
    const name = (Constants.deviceName || (Platform.OS === "ios" ? "iPhone" : "Android phone")).slice(0, 64);
    const descriptor = { id, name };
    let instance = instanceId();
    let lastContact = Date.now();
    let lost = false;
    let reporting = false;
    let reportAgain = false;
    let signature = "";
    let owned = false;
    publish({ ...descriptor, ready: false, error: null });
    const ownsOutput = () => sessionView()?.output?.endpointId === id;
    const metadata = () => {
      const track = currentTrack(sessionView());
      return { title: track?.name ?? "Ambra", artist: track?.artist, albumTitle: track?.album, artworkUrl: track?.cover || undefined };
    };

    const report = async () => {
      if (abort.signal.aborted) return;
      if (reporting) { reportAgain = true; return; }
      reporting = true;
      try {
        await endpointRequest(id, "presence", {
          method: "POST", signal: abort.signal,
          body: JSON.stringify({ name, instanceId: instance, devices: [{ id: PHONE_DEVICE_ID, name, isDefault: true }], selectedDeviceId: PHONE_DEVICE_ID, status: player!.status() }),
        });
        if (!abort.signal.aborted) {
          lastContact = Date.now();
          lost = false;
          if (!info?.ready) publish({ ...descriptor, ready: true, error: null });
        }
      } catch (reason) {
        if (reason instanceof Unpaired) { abort.abort(); player?.release(); }
        if (!abort.signal.aborted && !info?.ready) publish({ ...descriptor, ready: false, error: "Couldn't connect this phone to the server." });
      } finally {
        reporting = false;
        if (reportAgain && !abort.signal.aborted) { reportAgain = false; reportTimer = setTimeout(() => { void report(); }, 50); }
      }
    };
    const changed = () => {
      const status = player!.status();
      const next = JSON.stringify([status.currentSource, status.isPlaying, status.buffering, status.ended, status.error]);
      if (next !== signature) { signature = next; void report(); }
    };
    player = new PhonePlayback({
      create: source => createAudioPlayer(source, { updateInterval: 250, keepAudioSessionActive: true, allowsExternalPlayback: false }),
      activate: () => configureAudioSession(true),
      mediaUrl: phoneMediaUrl,
      metadata,
      ownsOutput,
      changed,
      transport: (action, details) => {
        if (ownsOutput() && !abort.signal.aborted) void command(action, details).catch(() => { player?.release(); });
      },
    });
    const sync = () => {
      const next = ownsOutput();
      if (next !== owned) {
        owned = next;
        if (!next) player?.release();
        void configureAudioSession(next).catch(() => {});
        changed();
      }
      if (next) player?.updateMetadata();
    };
    unsubscribe = subscribe(sync);
    sync();
    foreground = AppState.addEventListener("change", state => {
      if (state === "active") { void report(); void refreshSession(abort.signal).catch(() => {}); }
    });
    heartbeat = setInterval(() => {
      // An unreachable phone must not keep playing after the core can have moved elsewhere.
      if (!lost && Date.now() - lastContact > 8000) {
        lost = true;
        instance = instanceId();
        player?.release();
        publish({ ...descriptor, ready: false, error: "Connection lost. Reconnecting…" });
      }
      void report();
    }, 1000);

    await report();
    while (!abort.signal.aborted) {
      try {
        const jobs = await endpointRequest<Job[]>(id, "commands?wait=25", { signal: abort.signal });
        for (const job of jobs) {
          if (abort.signal.aborted) break;
          let result: { id: number; ok: boolean; value?: unknown; error?: string };
          try {
            if (["select_native_audio_device", "load_native_audio", "play_native_audio"].includes(job.command)) {
              await refreshSession(abort.signal);
              if (!ownsOutput()) throw new Error("This phone is no longer the selected output.");
            }
            const value = await player.execute(job.command, job.args ?? {});
            result = { id: job.id, ok: true, value };
          } catch (reason) { result = { id: job.id, ok: false, error: reason instanceof Error ? reason.message : "Phone playback failed." }; }
          await endpointRequest(id, "results", { method: "POST", signal: abort.signal, body: JSON.stringify(result) });
          void report();
        }
      } catch (reason) {
        if (reason instanceof Unpaired) { abort.abort(); player.release(); break; }
        if (!abort.signal.aborted) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 1000);
          abort.signal.addEventListener("abort", done, { once: true });
        });
      }
    }
  }).catch(() => {
    if (!abort.signal.aborted) publish({ id: "", name: "Phone", ready: false, error: "Couldn't prepare this phone for playback. Reopen Ambra to retry." });
  });

  return () => {
    abort.abort();
    unsubscribe();
    foreground?.remove();
    if (heartbeat) clearInterval(heartbeat);
    if (reportTimer) clearTimeout(reportTimer);
    player?.release();
    publish(null);
    void configureAudioSession(false).catch(() => {});
  };
}
