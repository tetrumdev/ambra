import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { coreCommand, coreView, coreViewAge, followCore, subscribeCore, type CoreView } from "../api/core";
import { serverConnection } from "../api/serverConnection";
import { createPlaybackClock } from "../utils/playbackClock";
import { useAudioSettings } from "./AudioSettingsContext";
import type { AudioDeckController, AudioPlayer } from "./useAudioPlayer";
import type { QueueController } from "./useQueue";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { acceptsPlaybackShortcut, isCharacterKey, isTypingTarget, isUnmodifiedKey } from "../utils/keyboard";
import { createOutputMediaControlHandler, ownsPlaybackOutput } from "../utils/outputMediaControls";

const noDeck = () => {};

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

  // The clock follows the server, sampled often enough to stay smooth between its updates.
  useEffect(() => {
    if (!view) return;
    const sample = () => {
      clock.set(positionOf(view));
      clock.setRunning(view.playing && !view.buffering && view.outputOnline);
    };
    sample();
    if (!view.playing) return;
    const timer = setInterval(sample, 500);
    return () => clearInterval(timer);
  }, [view, clock]);

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
  // App shortcuts control the shared transport; hardware controls only affect local playback.
  const shortcutState = useRef({ track: currentTrack, duration: view?.duration ?? 0 });
  shortcutState.current = { track: currentTrack, duration: view?.duration ?? 0 };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const current = shortcutState.current;
      if (isUnmodifiedKey(event, "Space") && !isTypingTarget(event.target)) {
        event.preventDefault();
        if (!event.repeat) { ensureOutput(); void coreCommand("toggle").catch(() => {}); }
        return;
      }
      if (!current.track) return;
      const step = isUnmodifiedKey(event, "ArrowLeft") ? -5 : isUnmodifiedKey(event, "ArrowRight") ? 5 : 0;
      if (step && acceptsPlaybackShortcut(event, true)) {
        event.preventDefault();
        const end = current.duration > 0 ? Math.max(0, current.duration - 1) : Infinity;
        const positionSeconds = Math.min(end, Math.max(0, clock.get() + step));
        clock.set(positionSeconds);
        void coreCommand("seek", { positionSeconds }).catch(() => {});
      } else if (acceptsPlaybackShortcut(event)) {
        const action = isCharacterKey(event, ",") ? "previous" : isCharacterKey(event, ".") ? "next" : null;
        if (action) { event.preventDefault(); if (!event.repeat) void coreCommand(action).catch(() => {}); }
      }
    };
    window.addEventListener("keydown", keydown);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const mediaControl = createOutputMediaControlHandler(serverConnection?.clientId, () => coreView()?.output, coreCommand);
    if (isTauri()) void listen<string>("native-media-control", ({ payload }) => {
      if (!disposed) mediaControl(payload);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); window.removeEventListener("keydown", keydown); clock.setRunning(false); };
  }, [clock, ensureOutput]);

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
      void invoke("set_native_media_playback", { isPlaying: localOutput && !!currentTrack && (view?.playing ?? false), positionSeconds }).catch(() => {});
    };
    update();
    return clock.subscribe(update);
  }, [clock, currentTrack, view?.playing, localOutput]);

  return {
    currentTrack,
    audioQuality: view?.audioQuality ?? null,
    clock,
    duration: view?.duration || currentTrack?.durationSeconds || 0,
    isPlaying: view?.playing ?? false,
    previousActivation,
    nextActivation,
    playbackError: view?.error ?? null,
    isSessionRestored: view !== null,
    togglePlayback: async () => {
      if (!coreView()?.playing) ensureOutput();
      await coreCommand("toggle");
    },
    previous: () => {
      setPreviousActivation(activation => activation + 1);
      void coreCommand("previous").catch(() => {});
    },
    next: () => {
      setNextActivation(activation => activation + 1);
      void coreCommand("next").catch(() => {});
    },
    seek: (time: number) => {
      clock.set(time);
      void coreCommand("seek", { positionSeconds: time }).catch(() => {});
    },
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
