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

const noDeck = () => {};

/** This device's engine, as the shared output reports it (remote_endpoint.rs `show_status`). */
type EngineStatus = { currentSource: string | null; currentTime: number; isPlaying: boolean; buffering: boolean };
/** The engine is followed only while it keeps reporting. */
const ENGINE_FRESH_MS = 1500;
/** How long a play, pause or skip shown at once waits for the server to agree. */
const PENDING_MS = 4000;
/** The server starts the song over instead of going back once it's past this (session.rs). */
const RESTART_AFTER_SECONDS = 3;

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

  // While this device is the output and its engine plays the server's song, the clock follows the
  // engine itself: what's heard here, with no trip to the server and back in between.
  const engine = useRef<{ status: EngineStatus; at: number } | null>(null);
  // A skip shown at once: the server's view of the song it leaves is ignored until it loads the next.
  const skipping = useRef<{ from: string | undefined; at: number } | null>(null);
  const followsEngine = useCallback(() => {
    const current = coreView();
    const heard = engine.current;
    if (skipping.current && (performance.now() - skipping.current.at > PENDING_MS || current?.loadedSource !== skipping.current.from)) skipping.current = null;
    return !!current && !!heard && !skipping.current && ownsPlaybackOutput(current.output, serverConnection?.clientId)
      && performance.now() - heard.at < ENGINE_FRESH_MS
      && !!current.loadedSource && heard.status.currentSource === current.loadedSource;
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<EngineStatus>("shared-output-status", ({ payload }) => {
      engine.current = { status: payload, at: performance.now() };
      if (!followsEngine()) return;
      clock.set(payload.currentTime);
      clock.setRunning(payload.isPlaying && !payload.buffering);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, [clock, followsEngine]);

  // Otherwise the clock follows the server, sampled often enough to stay smooth between its updates.
  useEffect(() => {
    if (!view) return;
    const sample = () => {
      // Mid-skip the server still describes the song being left; the clock waits at the start.
      if (followsEngine() || skipping.current) return;
      clock.set(positionOf(view));
      clock.setRunning(view.playing && !view.buffering && view.outputOnline);
    };
    sample();
    if (!view.playing) return;
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

  // Play and pause show at once, and on this device's own output take effect at once; the server
  // hears of it alongside and its view is shown again once it agrees.
  const [pendingPlaying, setPendingPlaying] = useState<{ playing: boolean; at: number } | null>(null);
  useEffect(() => {
    if (!pendingPlaying) return;
    if (view?.playing === pendingPlaying.playing) { setPendingPlaying(null); return; }
    const timer = setTimeout(() => setPendingPlaying(null), Math.max(0, pendingPlaying.at + PENDING_MS - performance.now()));
    return () => clearTimeout(timer);
  }, [pendingPlaying, view?.playing]);
  const playingNow = useRef(false);
  playingNow.current = pendingPlaying?.playing ?? view?.playing ?? false;
  /** Asks this device's engine directly, when it's the one playing the server's song. */
  const controlEngine = useCallback((action: "play" | "pause" | "seek", positionSeconds?: number) => {
    if (!followsEngine()) return;
    void invoke("shared_output_control", { action, positionSeconds }).catch(() => {});
  }, [followsEngine]);
  const setPlaying = useCallback((playing: boolean) => {
    if (playing) ensureOutput();
    setPendingPlaying({ playing, at: performance.now() });
    controlEngine(playing ? "play" : "pause");
    clock.setRunning(playing && !!coreView()?.output);
    return coreCommand(playing ? "play" : "pause");
  }, [clock, controlEngine, ensureOutput]);
  const seekTo = useCallback((positionSeconds: number) => {
    controlEngine("seek", positionSeconds);
    clock.setRunning(false);
    clock.set(positionSeconds);
    void coreCommand("seek", { positionSeconds }).catch(() => {});
  }, [clock, controlEngine]);
  const skip = useCallback((direction: "next" | "previous") => {
    if (direction === "previous" && clock.get() > RESTART_AFTER_SECONDS) {
      // Starting the song over, as the server will.
      seekTo(0);
      void coreCommand("previous").catch(() => {});
      return;
    }
    if (direction === "next" && followsEngine()) {
      // This device's engine usually has the next song ready already: it starts it at once, and
      // the server follows from its report as it does when a song ends.
      const from = coreView()?.loadedSource;
      clock.setRunning(false);
      clock.set(0);
      void invoke<boolean>("shared_output_skip").catch(() => false).then(skipped => {
        if (coreView()?.loadedSource !== from) return;
        if (queue.next(!skipped)) skipping.current = { from, at: performance.now() };
      });
      return;
    }
    const moved = direction === "next" ? queue.next() : queue.previous();
    if (!moved) return;
    skipping.current = { from: coreView()?.loadedSource, at: performance.now() };
    clock.setRunning(false);
    clock.set(0);
  }, [clock, followsEngine, queue, seekTo]);
  const transport = useRef({ setPlaying, seekTo, skip });
  transport.current = { setPlaying, seekTo, skip };
  // App shortcuts control the shared transport; hardware controls only affect local playback.
  const shortcutState = useRef({ track: currentTrack, duration: view?.duration ?? 0 });
  shortcutState.current = { track: currentTrack, duration: view?.duration ?? 0 };
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
  }, [clock, currentTrack, view?.playing, pendingPlaying, localOutput]);

  return {
    currentTrack,
    audioQuality: view?.audioQuality ?? null,
    clock,
    duration: view?.duration || currentTrack?.durationSeconds || 0,
    isPlaying: pendingPlaying?.playing ?? view?.playing ?? false,
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
