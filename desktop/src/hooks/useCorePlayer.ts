import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { coreCommand, coreView, coreViewAge, followCore, subscribeCore, type CoreView } from "../api/core";
import { serverConnection } from "../api/serverConnection";
import { createPlaybackClock } from "../utils/playbackClock";
import { useAudioSettings } from "./AudioSettingsContext";
import type { AudioDeckController, AudioPlayer } from "./useAudioPlayer";
import type { QueueController } from "./useQueue";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { acceptsPlaybackShortcut, isTypingTarget } from "../utils/keyboard";
import { matchesShortcut } from "../utils/shortcuts";
import { createOutputMediaControlHandler, ownsPlaybackOutput } from "../utils/outputMediaControls";
import { serverAudioSource } from "../utils/nativeAudioSource";

const noDeck = () => {};

/** This device's engine, as the shared output reports it (remote_endpoint.rs `show_status`). */
type EngineStatus = { currentSource: string | null; currentTime: number; duration?: number; isPlaying: boolean; buffering: boolean };
/** The engine is followed only while it keeps reporting. */
const ENGINE_FRESH_MS = 1500;
/** How long a play, pause or skip shown at once waits for the server to agree. */
const PENDING_MS = 4000;
/** The server starts the song over instead of going back once it's past this (session.rs). */
const RESTART_AFTER_SECONDS = 3;

/** The endpoint reports the server's URL; the UI uses its own bridge address and access token. */
function sameSource(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  const key = (source: string) => {
    const api = source.indexOf("/api/");
    if (api < 0) return source;
    const url = new URL(source.slice(api), "http://ambra.local");
    url.searchParams.delete("access_token");
    url.searchParams.sort();
    return url.pathname + url.search;
  };
  return key(left) === key(right);
}

/** Where the song is now, carrying `view`'s position forward while it plays. */
function positionOf(view: CoreView) {
  const running = view.playing && !view.buffering && view.outputOnline;
  const position = view.positionSeconds + (running ? Math.min(6, coreViewAge()) : 0);
  return view.duration > 0 ? Math.min(position, view.duration) : position;
}

/**
 * The server's playback, for every device alike: what's playing, where, and on which
 * output. The controls ask the server; nothing plays in this app unless the server picks
 * one of its outputs.
 */
export function useCorePlayer(queue: QueueController): AudioPlayer {
  useEffect(followCore, []);
  const view = useSyncExternalStore(subscribeCore, coreView);
  const audio = useAudioSettings();
  const [clock] = useState(createPlaybackClock);
  const [previousActivation, setPreviousActivation] = useState(0);
  const [nextActivation, setNextActivation] = useState(0);
  const firstAudioRef = useRef<HTMLAudioElement>(null);
  const secondAudioRef = useRef<HTMLAudioElement>(null);
  const latestQueue = useRef(queue);
  latestQueue.current = queue;
  const [enginePlaying, setEnginePlaying] = useState<boolean | null>(null);
  const [engineDuration, setEngineDuration] = useState<number | null>(null);
  const shownEngine = useRef<{ playing: boolean | null; duration: number | null }>({ playing: null, duration: null });

  // While this device is the output and its engine plays the server's song, the clock follows the
  // engine itself: what's heard here, with no trip to the server and back in between.
  const engine = useRef<{ status: EngineStatus; at: number } | null>(null);
  // A skip shown at once: the server's view of the song it leaves is ignored until it loads the next.
  const skipping = useRef<{ to: string; outputId: string | undefined; at: number } | null>(null);
  const followsEngine = useCallback(() => {
    const current = coreView();
    const heard = engine.current;
    const fresh = !!heard && performance.now() - heard.at < ENGINE_FRESH_MS;
    const pending = skipping.current;
    if (pending && (current?.output?.endpointId !== pending.outputId || sameSource(current?.loadedSource, pending.to)
      || (performance.now() - pending.at > PENDING_MS && !(fresh && sameSource(heard.status.currentSource, pending.to))))) {
      skipping.current = null;
    }
    const track = latestQueue.current.currentEntry?.track;
    // Direct streams belong to the selected track, even before the server confirms its load.
    // Live PCM has a session URL instead of the track URL, so use the server's source for it.
    const source = skipping.current?.to ?? (current?.loadedSource?.includes("/api/playback/live/")
      ? current.loadedSource : (track && serverAudioSource(track)) ?? current?.loadedSource);
    return !!current && fresh && ownsPlaybackOutput(current.output, serverConnection?.clientId)
      && sameSource(heard.status.currentSource, source);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<EngineStatus>("shared-output-status", ({ payload }) => {
      if (disposed) return;
      const heardBefore = engine.current?.status.currentSource;
      engine.current = { status: payload, at: performance.now() };
      const queue = latestQueue.current;
      const next = queue.peekNext()?.track;
      const current = queue.currentEntry?.track;
      // A gapless handoff is already audible here, even if the server still shows the old song.
      // Only an actual move from the current song to the next one counts: after going back (or
      // replaying a played song) the song being left is "next", and the engine keeps reporting it
      // until the server's load arrives.
      if (!skipping.current && next && current && ownsPlaybackOutput(coreView()?.output, serverConnection?.clientId)
        && sameSource(heardBefore, serverAudioSource(current))
        && sameSource(payload.currentSource, serverAudioSource(next))
        && !sameSource(payload.currentSource, current && serverAudioSource(current))) {
        skipping.current = { to: serverAudioSource(next), outputId: coreView()?.output?.endpointId, at: performance.now() };
        queue.next(false);
        clock.setRunning(false);
        clock.set(0);
      }
      if (!followsEngine()) return;
      clock.set(payload.currentTime);
      clock.setRunning(payload.isPlaying && !payload.buffering);
      // Reported ten times a second; only a change may rerender the app, never a repeat.
      const playing = payload.isPlaying || payload.buffering;
      const duration = typeof payload.duration === "number" && Number.isFinite(payload.duration) && payload.duration > 0 ? payload.duration : null;
      if (shownEngine.current.playing !== playing) setEnginePlaying(shownEngine.current.playing = playing);
      if (shownEngine.current.duration !== duration) setEngineDuration(shownEngine.current.duration = duration);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, [clock, followsEngine]);

  // Otherwise the clock follows the server, sampled often enough to stay smooth between its updates.
  useEffect(() => {
    if (!view) return;
    const sample = () => {
      // Mid-skip the server still describes the song being left; the clock waits at the start.
      if (followsEngine() || skipping.current) return;
      if (shownEngine.current.playing !== null) setEnginePlaying(shownEngine.current.playing = null);
      if (shownEngine.current.duration !== null) setEngineDuration(shownEngine.current.duration = null);
      clock.set(positionOf(view));
      clock.setRunning(view.playing && !view.buffering && view.outputOnline);
    };
    sample();
    if (!view.playing && !ownsPlaybackOutput(view.output, serverConnection?.clientId)) return;
    const timer = setInterval(sample, 500);
    return () => clearInterval(timer);
  }, [view, clock, followsEngine]);

  const latestAudio = useRef(audio);
  latestAudio.current = audio;
  /** With no output chosen yet, playing starts on this computer's current one. */
  const ensureOutput = useCallback(() => {
    if (coreView()?.output || !serverConnection) return;
    const settings = latestAudio.current?.settings;
    const deviceId = settings?.selectedOutputId ?? "";
    const deviceName = settings?.outputs.find(output => output.id === deviceId)?.name ?? "System Output";
    void coreCommand("output", {
      output: { endpointId: serverConnection.clientId, deviceId, endpointName: serverConnection.clientName, deviceName },
    }).catch(() => {});
  }, []);

  const audioDecks = useMemo<AudioDeckController>(() => ({
    firstAudioRef, secondAudioRef,
    onLoadedMetadata: noDeck, onDurationChange: noDeck, onTimeUpdate: noDeck, onCanPlay: noDeck,
    onPlaying: noDeck, onPause: noDeck, onWaiting: noDeck, onEnded: noDeck,
  }), []);

  const currentTrack = queue.currentEntry?.track;
  const localOutput = ownsPlaybackOutput(view?.output, serverConnection?.clientId);
  // A local skip can be audible before the server confirms it. The old song's duration
  // must not be paired with the new title, progress bar, or seek limits.
  const sessionMatchesTrack = !!currentTrack && view?.queue.current?.globalTrackId === currentTrack.globalId
    && (!view.loadedSource || view.loadedSource.includes("/api/playback/live/")
      || sameSource(view.loadedSource, serverAudioSource(currentTrack)));
  const engineMatchesTrack = !!currentTrack
    && (sameSource(engine.current?.status.currentSource, serverAudioSource(currentTrack)) || sessionMatchesTrack);
  const duration = (engineMatchesTrack && followsEngine() ? engineDuration : null)
    ?? ((sessionMatchesTrack ? view?.duration : 0) || currentTrack?.durationSeconds || 0);

  // Play and pause show at once. On this device's own output they act on its engine alone, which
  // the server takes on from the engine's next report; elsewhere the server is asked.
  const [pendingPlaying, setPendingPlaying] = useState<{ playing: boolean; at: number } | null>(null);
  useEffect(() => {
    if (!pendingPlaying) return;
    if (view?.playing === pendingPlaying.playing) { setPendingPlaying(null); return; }
    const timer = setTimeout(() => setPendingPlaying(null), Math.max(0, pendingPlaying.at + PENDING_MS - performance.now()));
    return () => clearTimeout(timer);
  }, [pendingPlaying, view?.playing]);
  const playingNow = useRef(false);
  playingNow.current = pendingPlaying?.playing ?? (followsEngine() ? enginePlaying : null) ?? view?.playing ?? false;
  /**
   * Plays, pauses or seeks with this device's engine, when it's the one playing the server's
   * song: the listener here has full control, however slow the way to the server is. Otherwise,
   * or if the engine can't, the server is asked.
   */
  const control = useCallback(async (action: "play" | "pause" | "seek", positionSeconds?: number) => {
    if (followsEngine()) {
      try {
        await invoke("shared_output_control", { action, positionSeconds });
        return;
      } catch { /* No longer this device's to play: the server decides. */ }
    }
    await coreCommand(action, action === "seek" ? { positionSeconds } : {});
  }, [followsEngine]);
  const setPlaying = useCallback((playing: boolean) => {
    if (playing) ensureOutput();
    setPendingPlaying({ playing, at: performance.now() });
    clock.setRunning(playing && !!coreView()?.output);
    return control(playing ? "play" : "pause");
  }, [clock, control, ensureOutput]);
  const seekTo = useCallback((positionSeconds: number) => {
    clock.setRunning(false);
    clock.set(positionSeconds);
    void control("seek", positionSeconds).catch(() => {});
  }, [clock, control]);
  /**
   * Silences the song being left on this device's engine while the core moves on, so a slow or
   * lost skip can't leave it playing. The core's load of the next song plays as it asks.
   */
  const holdForSkip = useCallback(() => {
    void invoke("shared_output_control", { action: "hold" }).catch(() => {});
  }, []);
  const skip = useCallback((direction: "next" | "previous") => {
    if (direction === "previous" && clock.get() > RESTART_AFTER_SECONDS) {
      // Starting the song over. Only a seek: a "previous" sent after it would find the server
      // already at 0 and go back a song instead.
      seekTo(0);
      return;
    }
    if (direction === "next" && followsEngine()) {
      // This device's engine usually has the next song ready already: it starts it at once, and
      // the server follows from its report as it does when a song ends.
      const from = coreView()?.loadedSource;
      const next = queue.peekNext()?.track;
      if (!next) { queue.next(); return; }
      const pending = { to: serverAudioSource(next), outputId: coreView()?.output?.endpointId, at: performance.now() };
      skipping.current = pending;
      clock.setRunning(false);
      clock.set(0);
      void invoke<boolean>("shared_output_skip").catch(() => false).then(skipped => {
        if (skipping.current !== pending) return;
        if (coreView()?.loadedSource !== from) { skipping.current = null; return; }
        // Not ready here: the old song stops while the core moves on.
        if (!skipped) holdForSkip();
        if (!queue.next(!skipped)) skipping.current = null;
      });
      return;
    }
    const local = followsEngine();
    const moved = direction === "next" ? queue.next() : queue.previous();
    if (!moved) return;
    if (local) holdForSkip();
    skipping.current = { to: serverAudioSource(moved.track), outputId: coreView()?.output?.endpointId, at: performance.now() };
    clock.setRunning(false);
    clock.set(0);
  }, [clock, followsEngine, holdForSkip, queue, seekTo]);
  const transport = useRef({ setPlaying, seekTo, skip });
  transport.current = { setPlaying, seekTo, skip };
  // App shortcuts control the shared transport; hardware controls only affect local playback.
  const shortcutState = useRef({ track: currentTrack, duration });
  shortcutState.current = { track: currentTrack, duration };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const current = shortcutState.current;
      if (matchesShortcut(event, "playPause") && !isTypingTarget(event.target)) {
        event.preventDefault();
        if (!event.repeat) void transport.current.setPlaying(!playingNow.current).catch(() => {});
        return;
      }
      if (!current.track) return;
      const step = matchesShortcut(event, "seekBackward") ? -5 : matchesShortcut(event, "seekForward") ? 5 : 0;
      if (step && acceptsPlaybackShortcut(event, true)) {
        event.preventDefault();
        const end = current.duration > 0 ? Math.max(0, current.duration - 1) : Infinity;
        transport.current.seekTo(Math.min(end, Math.max(0, clock.get() + step)));
      } else if (acceptsPlaybackShortcut(event)) {
        const action = matchesShortcut(event, "previousTrack") ? "previous" : matchesShortcut(event, "nextTrack") ? "next" : null;
        if (action) {
          event.preventDefault();
          if (event.repeat) return;
          if (action === "next") setNextActivation(activation => activation + 1);
          else setPreviousActivation(activation => activation + 1);
          transport.current.skip(action);
        }
      }
    };
    window.addEventListener("keydown", keydown);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Headset and system controls go the same way as the app's own buttons.
    const mediaControl = createOutputMediaControlHandler(serverConnection?.clientId, () => coreView()?.output, async action => {
      if (action === "play" || action === "pause" || action === "toggle") {
        await transport.current.setPlaying(action === "toggle" ? !playingNow.current : action === "play");
      } else if (action === "next" || action === "previous") {
        transport.current.skip(action);
      }
    });
    if (isTauri()) void listen<string>("native-media-control", ({ payload }) => {
      if (!disposed) mediaControl(payload);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); window.removeEventListener("keydown", keydown); clock.setRunning(false); };
  }, [clock]);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_native_media_commands_enabled", { enabled: localOutput && !!currentTrack }).catch(() => {});
    if (!localOutput || !currentTrack) return;
    void invoke("set_native_media_metadata", { metadata: {
      title: currentTrack.name, artist: currentTrack.artist, album: currentTrack.album,
      durationSeconds: currentTrack.durationSeconds, coverSource: currentTrack.nativeCover,
      assetSource: currentTrack.audio,
    } }).catch(error => console.warn("Could not update Now Playing:", error));
  }, [currentTrack, localOutput]);

  useEffect(() => {
    if (!isTauri()) return;
    let lastSecond = -1;
    const update = () => {
      const positionSeconds = localOutput ? Math.floor(clock.get()) : 0;
      if (positionSeconds === lastSecond) return;
      lastSecond = positionSeconds;
      void invoke("set_native_media_playback", { isPlaying: localOutput && !!currentTrack && playingNow.current, positionSeconds }).catch(() => {});
    };
    update();
    return clock.subscribe(update);
  }, [clock, currentTrack, view?.playing, pendingPlaying, enginePlaying, localOutput]);

  return {
    currentTrack,
    audioQuality: view?.audioQuality ?? null,
    clock,
    duration,
    isPlaying: playingNow.current,
    previousActivation,
    nextActivation,
    playbackError: view?.error ?? null,
    isSessionRestored: view !== null,
    togglePlayback: async () => {
      await setPlaying(!playingNow.current);
    },
    previous: () => {
      setPreviousActivation(activation => activation + 1);
      skip("previous");
    },
    next: () => {
      setNextActivation(activation => activation + 1);
      skip("next");
    },
    seek: seekTo,
    audioDecks,
    // The queue change just before this carries it, so the server starts the song once.
    playTrack: (trackId: string) => {
      void coreCommand("playTrack", { trackId }).catch(() => {});
      ensureOutput();
    },
    clear: () => { void coreCommand("stop").catch(() => {}); },
    reclaim: noDeck,
    release: async () => {},
  };
}
