import { createAudioPlayer } from "expo-audio";
import Constants from "expo-constants";
import { AppState, Platform } from "react-native";
import { configureAudioSession } from "./audioSession";
import { type SessionView, Unpaired, clientId, command, currentTrack, endpointRequest, phoneMediaUrl, prefetchMedia, refreshSession, sessionView, setLocalControl, setLocalPlayback, subscribe } from "./client";
import { PHONE_DEVICE_ID, PhonePlayback } from "./phonePlayback";
import { phoneUrlForSource } from "./downloads";

export type PhoneEndpointInfo = { id: string; name: string; ready: boolean; error: string | null };
let info: PhoneEndpointInfo | null = null;
const listeners = new Set<() => void>();
export const phoneEndpointInfo = () => info;
export function subscribePhoneEndpoint(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(next: PhoneEndpointInfo | null) { info = next; for (const listener of listeners) listener(); }
type Job = { id: number; command: string; args: Record<string, unknown> };
const instanceId = () => `phone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
/** The server shows the phone offline after this long without word from it. */
const QUIET_MS = 8000;
/** The phone's own position is shown again once it drifts this far from the one last shown. */
const LOCAL_DRIFT_SECONDS = 0.5;
/** Changes when a skip moves the queue, even onto another copy of the same song. */
const queueMark = (view: SessionView | null) => {
  const queue = view?.queue;
  return JSON.stringify([queue?.current?.globalTrackId ?? null, queue?.history?.length ?? 0, queue?.upcoming.length ?? 0]);
};

/** The phone reports presence and executes the core's output commands, just as desktop does. */
export function followPhoneOutput() {
  const abort = new AbortController();
  let player: PhonePlayback | null = null;
  let unsubscribe = () => {};
  let foreground: { remove(): void } | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reportTimer: ReturnType<typeof setTimeout> | null = null;
  let depart = () => {};

  void clientId().then(async id => {
    if (abort.signal.aborted) return;
    const name = (Constants.deviceName || (Platform.OS === "ios" ? "iPhone" : "Android phone")).slice(0, 64);
    const descriptor = { id, name };
    const instance = instanceId();
    depart = () => { void endpointRequest(id, "departure", { method: "POST", body: JSON.stringify({ instanceId: instance }) }).catch(() => {}); };
    let lastContact = Date.now();
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
          if (!info?.ready) publish({ ...descriptor, ready: true, error: null });
        }
      } catch (reason) {
        if (reason instanceof Unpaired) { abort.abort(); player?.release(); }
        if (!abort.signal.aborted && !info?.ready) publish({ ...descriptor, ready: false, error: reason instanceof Error ? reason.message : "Couldn't connect this phone to the server." });
      } finally {
        reporting = false;
        if (reportAgain && !abort.signal.aborted) { reportAgain = false; reportTimer = setTimeout(() => { void report(); }, 50); }
      }
    };
    // While this phone plays the server's song, its screens follow its own player.
    let shownLocal: { playing: boolean; buffering: boolean; positionSeconds: number; at: number } | null = null;
    const playsCore = () => ownsOutput() && player!.controls(sessionView()?.loadedSource);
    const showLocal = () => {
      const status = player!.status();
      if (!playsCore()) { shownLocal = null; setLocalPlayback(null); return; }
      const playing = status.isPlaying || status.buffering;
      const buffering = status.buffering;
      const at = Date.now();
      const expected = shownLocal ? shownLocal.positionSeconds + (shownLocal.playing && !shownLocal.buffering ? (at - shownLocal.at) / 1000 : 0) : NaN;
      if (shownLocal && shownLocal.playing === playing && shownLocal.buffering === buffering
        && Math.abs(expected - status.currentTime) < LOCAL_DRIFT_SECONDS) return;
      shownLocal = { playing, buffering, positionSeconds: status.currentTime, at };
      setLocalPlayback(shownLocal);
    };
    const changed = () => {
      const status = player!.status();
      const next = JSON.stringify([status.currentSource, status.isPlaying, status.buffering, status.ended, status.error, status.control?.seq]);
      if (next !== signature) { signature = next; void report(); }
      showLocal();
    };
    player = new PhonePlayback({
      create: source => createAudioPlayer(source, { updateInterval: 250, keepAudioSessionActive: true, allowsExternalPlayback: false }),
      activate: () => configureAudioSession(true),
      // A song downloaded to this phone plays from that copy, sparing the network.
      mediaUrl: source => phoneUrlForSource(source) ?? phoneMediaUrl(source),
      prefetch: source => { if (!phoneUrlForSource(source)) prefetchMedia(source); },
      metadata,
      ownsOutput,
      changed,
      transport: (action, details) => {
        // A command lost to a network change is reconciled from the next report; only a
        // phone that is no longer the output stops.
        if (ownsOutput() && !abort.signal.aborted) void command(action, details).catch(() => { if (!ownsOutput()) player?.release(); });
      },
    });
    setLocalControl((action, details) => {
      if (!player || !playsCore()) return false;
      const playing = player.status().isPlaying || player.status().buffering;
      if (action === "play" || action === "pause" || action === "toggle") {
        void player.local(action === "toggle" ? (playing ? "pause" : "play") : action);
        return true;
      }
      if (action === "seek" && Number.isFinite(Number(details.positionSeconds))) {
        void player.local("seek", Math.max(0, Number(details.positionSeconds)));
        return true;
      }
      if (action === "startTrack") {
        // The core loads the new song next; only a lost request leaves this phone to pause.
        const held = player;
        if (!held.holdForSkip()) return false;
        return answer => { if (!answer) held.endSkip(false); };
      }
      if (action === "next" || action === "previous") {
        // Silence the old song until the core moves on, so a slow or lost skip can't let it
        // play on. The core then loads the next song, or seeks for a previous that restarts.
        const before = queueMark(sessionView());
        const held = player;
        if (!held.holdForSkip()) return false;
        return answer => {
          if (!answer) held.endSkip(false);
          // A next with nothing after the current song leaves the queue as it was.
          else if (action === "next" && queueMark(answer) === before) held.endSkip(true);
        };
      }
      return false;
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
      showLocal();
    };
    unsubscribe = subscribe(sync);
    sync();
    foreground = AppState.addEventListener("change", state => {
      if (state === "active") { void report(); void refreshSession(abort.signal).catch(() => {}); }
    });
    let quiet = false;
    heartbeat = setInterval(() => {
      const silence = Date.now() - lastContact;
      // Out of reach: keep playing what is already downloaded, under this phone's own control,
      // until the server answers again. Only the server choosing another output stops it.
      if (!quiet && silence > QUIET_MS) {
        quiet = true;
        publish({ ...descriptor, ready: true, error: "Reconnecting…" });
      }
      if (silence <= QUIET_MS && quiet) {
        quiet = false;
        publish({ ...descriptor, ready: true, error: null });
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
  }).catch(reason => {
    if (!abort.signal.aborted) publish({ id: "", name: "Phone", ready: false, error: reason instanceof Error ? reason.message : "Couldn't prepare this phone for playback. Reopen Ambra to retry." });
  });

  return () => {
    depart();
    abort.abort();
    unsubscribe();
    foreground?.remove();
    if (heartbeat) clearInterval(heartbeat);
    if (reportTimer) clearTimeout(reportTimer);
    setLocalControl(null);
    setLocalPlayback(null);
    player?.release();
    publish(null);
    void configureAudioSession(false).catch(() => {});
  };
}
