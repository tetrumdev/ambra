import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { preloadBigscreenArtwork } from "../utils/artworkImages";
import type { MediaPlayerClass } from "dashjs";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Deck, Track } from "../types/music";
import { canAttemptPlayback } from "../utils/playbackReadiness";
import {
  nativeAudioSource,
  trackForNativeAudioStatus,
} from "../utils/nativeAudioSource";
import { trackPosition } from "../utils/trackOrder";
import { playbackRestore } from "../utils/playbackRestore";
import { isUnmodifiedKey } from "../utils/keyboard";
import { NativePlaybackCommands } from "../utils/nativePlaybackCommands";

export type AudioDeckController = {
  firstAudioRef: RefObject<HTMLAudioElement | null>;
  secondAudioRef: RefObject<HTMLAudioElement | null>;
  onLoadedMetadata: (
    deck: Deck,
    event: SyntheticEvent<HTMLAudioElement>,
  ) => void;
  onDurationChange: (
    deck: Deck,
    event: SyntheticEvent<HTMLAudioElement>,
  ) => void;
  onTimeUpdate: (deck: Deck, event: SyntheticEvent<HTMLAudioElement>) => void;
  onCanPlay: (deck: Deck) => void;
  onPlaying: (deck: Deck) => void;
  onPause: (deck: Deck) => void;
  onEnded: (deck: Deck) => void;
};

type AudioPlayer = {
  currentTrack: Track | undefined;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  isSessionRestored: boolean;
  togglePlayback: () => Promise<void>;
  previous: () => void;
  next: () => void;
  seek: (time: number) => void;
  audioDecks: AudioDeckController;
  playTrack: (trackId: string, preparedTrack?: Track) => void;
  clear: () => void;
};

type InitialPlayback = {
  trackId: string | null;
  positionSeconds: number;
};

export type AudioQueueNavigation = {
  next: () => Track | undefined;
  completeCurrent: () => Track | undefined;
  previous: () => Track | undefined;
  peekNext: () => Track | undefined;
  nextTrack: Track | undefined;
};

type NativeAudioStatus = {
  currentSource: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  buffering: boolean;
  ended: boolean;
  error: string | null;
};

export function useAudioPlayer(
  tracks: Track[],
  initialPlayback: InitialPlayback,
  queueNavigation: AudioQueueNavigation,
): AudioPlayer {
  const firstAudioRef = useRef<HTMLAudioElement>(null);
  const secondAudioRef = useRef<HTMLAudioElement>(null);
  const tracksRef = useRef<Track[]>(tracks);
  const activeDeckRef = useRef<Deck>(0);
  const deckGenerationsRef = useRef<[number, number]>([0, 0]);
  const currentTrackIdRef = useRef<string | null>(null);
  const currentTimeRef = useRef(0);
  const nativePlayIntentRef = useRef(false);
  const nativeCommandsRef = useRef(new NativePlaybackCommands(invoke));
  const initialPlaybackRef = useRef(initialPlayback);
  const restoreStartedRef = useRef(false);
  const queueNavigationRef = useRef(queueNavigation);
  const pendingRestoreTimeRef = useRef<number | null>(null);
  const pendingPlaybackDeckRef = useRef<Deck | null>(null);
  const lastRemoteActionRef = useRef({ action: "", timestamp: 0 });
  const deckPlaybackKindsRef = useRef<Array<Track["playbackKind"] | null>>([
    null,
    null,
  ]);
  const dashPlayersRef = useRef<Array<MediaPlayerClass | null>>([null, null]);
  const nativeLoadGenerationRef = useRef(0);
  const nativeReadyGenerationRef = useRef<number | null>(null);

  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSessionRestored, setIsSessionRestored] = useState(false);

  tracksRef.current = tracks;
  queueNavigationRef.current = queueNavigation;
  currentTimeRef.current = currentTime;
  const usesNativeAudio = isTauri();
  const currentTrack = tracks.find(
    (track) => track.globalId === currentTrackId,
  );

  const nextArtworkTrack = queueNavigation.nextTrack;
  useEffect(() => {
    if (!nextArtworkTrack) return;
    void preloadBigscreenArtwork(nextArtworkTrack);
  }, [
    nextArtworkTrack?.albumId,
    nextArtworkTrack?.cover,
    nextArtworkTrack?.globalId,
    nextArtworkTrack?.nativeCover,
    nextArtworkTrack?.provider,
  ]);

  const audioForDeck = useCallback(
    (deck: Deck) =>
      deck === 0 ? firstAudioRef.current : secondAudioRef.current,
    [],
  );

  const activeAudio = useCallback(
    () => audioForDeck(activeDeckRef.current),
    [audioForDeck],
  );

  const runRemoteAction = useCallback((action: string, handler: () => void) => {
    const timestamp = performance.now();
    const previous = lastRemoteActionRef.current;
    if (previous.action === action && timestamp - previous.timestamp < 300) {
      return;
    }

    lastRemoteActionRef.current = { action, timestamp };
    handler();
  }, []);

  const releaseDeck = useCallback(
    (deck: Deck) => {
      deckGenerationsRef.current[deck]++;
      if (pendingPlaybackDeckRef.current === deck) {
        pendingPlaybackDeckRef.current = null;
      }

      const dashPlayer = dashPlayersRef.current[deck];
      if (dashPlayer) {
        dashPlayer.reset();
        dashPlayersRef.current[deck] = null;
      }

      const audio = audioForDeck(deck);
      if (!audio) return;
      audio.pause();
      audio.removeAttribute("src");
      delete audio.dataset.trackId;
      deckPlaybackKindsRef.current[deck] = null;
    },
    [audioForDeck],
  );

  const clearPlayback = useCallback(() => {
    restoreStartedRef.current = true;
    nativeLoadGenerationRef.current += 1;
    nativeReadyGenerationRef.current = null;
    currentTrackIdRef.current = null;
    currentTimeRef.current = 0;
    nativePlayIntentRef.current = false;
    pendingRestoreTimeRef.current = null;
    pendingPlaybackDeckRef.current = null;
    releaseDeck(0);
    releaseDeck(1);
    setCurrentTrackId(null);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setIsSessionRestored(true);
  }, [releaseDeck]);

  const prepareDeck = useCallback(
    (deck: Deck, trackIndex: number) => {
      const audio = audioForDeck(deck);
      const track = tracksRef.current[trackIndex];

      if (!audio || !track) return;
      if (audio.dataset.trackId === track.globalId) return;

      releaseDeck(deck);
      audio.dataset.trackId = track.globalId;
      if (usesNativeAudio) return;
      deckPlaybackKindsRef.current[deck] = track.playbackKind;

      if (track.playbackKind === "dash") {
        const generation = deckGenerationsRef.current[deck];
        void import("dashjs").then(({ MediaPlayer }) => {
          if (deckGenerationsRef.current[deck] !== generation) return;
          const dashPlayer = MediaPlayer().create();
          dashPlayersRef.current[deck] = dashPlayer;
          dashPlayer.initialize(audio, track.audio, false);
        }).catch(error => console.error("Could not load browser DASH playback:", error));
      } else {
        audio.src = track.audio;
        audio.load();
      }
    },
    [audioForDeck, releaseDeck, usesNativeAudio],
  );

  const loadNativeTrack = useCallback(
    (track: Track, positionSeconds: number, autoplay: boolean) => {
      const nextTrack = queueNavigationRef.current.peekNext();
      const loadGeneration = nativeLoadGenerationRef.current + 1;
      nativeLoadGenerationRef.current = loadGeneration;
      nativeReadyGenerationRef.current = null;
      nativePlayIntentRef.current = autoplay;

      void nativeCommandsRef.current.run("load_native_audio", {
        source: nativeAudioSource(track),
        nextSource: nextTrack ? nativeAudioSource(nextTrack) : null,
        positionSeconds,
        autoplay,
      })
        .then(() => {
          if (nativeLoadGenerationRef.current !== loadGeneration) return;
          nativeReadyGenerationRef.current = loadGeneration;
          setIsSessionRestored(true);
        })
        .catch((error) => {
          if (nativeLoadGenerationRef.current !== loadGeneration) return;
          nativeReadyGenerationRef.current = loadGeneration;
          nativePlayIntentRef.current = false;
          setIsPlaying(false);
          setIsSessionRestored(true);
          console.error("Could not load native audio:", error);
        });
    },
    [],
  );

  const requestDeckPlayback = useCallback(
    (deck: Deck) => {
      const audio = audioForDeck(deck);
      if (!audio || deck !== activeDeckRef.current) return;

      pendingPlaybackDeckRef.current = deck;
      if (
        !canAttemptPlayback(
          deckPlaybackKindsRef.current[deck],
          audio.readyState,
        )
      ) {
        return;
      }

      void audio.play().catch((error) => {
        if (pendingPlaybackDeckRef.current === deck) {
          console.debug("Playback is waiting for media readiness:", error);
        }
      });
    },
    [audioForDeck],
  );

  const switchToTrack = useCallback(
    (requestedIndex: number, shouldPlay: boolean) => {
      const library = tracksRef.current;
      if (library.length === 0) return;

      pendingRestoreTimeRef.current = null;

      const targetIndex = requestedIndex;
      const targetTrack = library[targetIndex];
      if (!targetTrack) return;
      restoreStartedRef.current = true;

      if (usesNativeAudio) {
        currentTrackIdRef.current = targetTrack.globalId;
        setCurrentTrackId(targetTrack.globalId);
        setCurrentTime(0);
        setDuration(targetTrack.durationSeconds);
        currentTimeRef.current = 0;
        setIsPlaying(shouldPlay);
        setIsSessionRestored(false);
        loadNativeTrack(targetTrack, 0, shouldPlay);
        return;
      }

      const outgoingDeck = activeDeckRef.current;
      const incomingDeck: Deck = outgoingDeck === 0 ? 1 : 0;
      const outgoingAudio = audioForDeck(outgoingDeck);
      const incomingAudio = audioForDeck(incomingDeck);

      if (!outgoingAudio || !incomingAudio) return;

      // Sequential changes use the deck that was preloaded in advance.
      prepareDeck(incomingDeck, targetIndex);

      outgoingAudio.pause();
      outgoingAudio.currentTime = 0;
      activeDeckRef.current = incomingDeck;
      currentTrackIdRef.current = targetTrack.globalId;

      setCurrentTrackId(targetTrack.globalId);
      setCurrentTime(0);
      setDuration(
        Number.isFinite(incomingAudio.duration) ? incomingAudio.duration : 0,
      );
      setIsPlaying(false);

      if (shouldPlay) {
        requestDeckPlayback(incomingDeck);
      }

      const followingTrack = queueNavigationRef.current.peekNext();
      const followingIndex = followingTrack
        ? trackPosition(library, followingTrack.globalId)
        : -1;
      if (followingIndex >= 0) prepareDeck(outgoingDeck, followingIndex);
      else releaseDeck(outgoingDeck);
    },
    [
      audioForDeck,
      loadNativeTrack,
      prepareDeck,
      releaseDeck,
      requestDeckPlayback,
      usesNativeAudio,
    ],
  );

  const seek = useCallback(
    (time: number) => {
      if (usesNativeAudio) {
        setCurrentTime(time);
        void nativeCommandsRef.current.run("seek_native_audio", { positionSeconds: time }).catch(
          (error) => console.warn("Could not seek native audio:", error),
        );
        return;
      }

      const deck = activeDeckRef.current;
      const audio = activeAudio();
      if (!audio) return;

      const shouldContinue =
        !audio.paused || pendingPlaybackDeckRef.current === deck;
      audio.currentTime = time;
      setCurrentTime(time);
      if (shouldContinue) requestDeckPlayback(deck);
    },
    [activeAudio, requestDeckPlayback, usesNativeAudio],
  );

  const playActive = useCallback(() => {
    if (usesNativeAudio) {
      nativePlayIntentRef.current = true;
      setIsPlaying(true);
      void nativeCommandsRef.current.run("play_native_audio").catch((error) =>
        console.warn("Could not play native audio:", error),
      );
      return;
    }
    requestDeckPlayback(activeDeckRef.current);
  }, [requestDeckPlayback, usesNativeAudio]);

  const pauseActive = useCallback(() => {
    if (usesNativeAudio) {
      nativePlayIntentRef.current = false;
      setIsPlaying(false);
      void nativeCommandsRef.current.run("pause_native_audio").catch((error) =>
        console.warn("Could not pause native audio:", error),
      );
      return;
    }
    pendingPlaybackDeckRef.current = null;
    activeAudio()?.pause();
  }, [activeAudio, usesNativeAudio]);

  const stopPlayback = useCallback(() => {
    pauseActive();
    clearPlayback();
  }, [clearPlayback, pauseActive]);

  const togglePlayback = useCallback(async () => {
    if (usesNativeAudio) {
      if (nativePlayIntentRef.current) pauseActive();
      else playActive();
      return;
    }

    const deck = activeDeckRef.current;
    const audio = activeAudio();
    if (!audio) return;

    if (!audio.paused) {
      pendingPlaybackDeckRef.current = null;
      audio.pause();
      return;
    }

    requestDeckPlayback(deck);
  }, [
    activeAudio,
    pauseActive,
    playActive,
    requestDeckPlayback,
    usesNativeAudio,
  ]);

  const playTrack = useCallback(
    (trackId: string, preparedTrack?: Track) => {
      if (preparedTrack) {
        const preparedIndex = trackPosition(
          tracksRef.current,
          preparedTrack.globalId,
        );
        tracksRef.current = preparedIndex < 0
          ? [...tracksRef.current, preparedTrack]
          : tracksRef.current.map((track, index) =>
              index === preparedIndex ? preparedTrack : track,
            );
      }
      const trackIndex = trackPosition(tracksRef.current, trackId);
      if (trackIndex < 0) return;
      switchToTrack(trackIndex, true);
    },
    [switchToTrack],
  );

  const previous = useCallback(() => {
    if (usesNativeAudio) {
      if (currentTimeRef.current > 3) {
        seek(0);
        return;
      }
      const previousTrack = queueNavigationRef.current.previous();
      if (!previousTrack) {
        seek(0);
        return;
      }
      const previousIndex = trackPosition(tracksRef.current, previousTrack.globalId);
      if (previousIndex >= 0) {
        switchToTrack(previousIndex, nativePlayIntentRef.current);
      }
      return;
    }

    const audio = activeAudio();
    if (!audio) return;

    if (audio.currentTime > 3) {
      seek(0);
      return;
    }

    const previousTrack = queueNavigationRef.current.previous();
    if (!previousTrack) {
      seek(0);
      return;
    }
    const previousIndex = trackPosition(tracksRef.current, previousTrack.globalId);
    if (previousIndex < 0) return;

    const shouldContinue =
      !audio.paused || pendingPlaybackDeckRef.current === activeDeckRef.current;
    switchToTrack(previousIndex, shouldContinue);
  }, [activeAudio, seek, switchToTrack, usesNativeAudio]);

  const next = useCallback(() => {
    const nextTrack = queueNavigationRef.current.next();
    if (!nextTrack) return;
    const nextIndex = trackPosition(tracksRef.current, nextTrack.globalId);
    if (nextIndex < 0) return;

    if (usesNativeAudio) {
      switchToTrack(nextIndex, nativePlayIntentRef.current);
      return;
    }

    const audio = activeAudio();
    if (!audio) return;

    const shouldContinue =
      (!audio.paused ||
        pendingPlaybackDeckRef.current === activeDeckRef.current) &&
      !audio.ended;
    switchToTrack(nextIndex, shouldContinue);
  }, [activeAudio, switchToTrack, usesNativeAudio]);

  const onLoadedMetadata = useCallback(
    (deck: Deck, event: SyntheticEvent<HTMLAudioElement>) => {
      if (deck !== activeDeckRef.current) return;

      const loadedDuration = event.currentTarget.duration;
      setDuration(Number.isFinite(loadedDuration) ? loadedDuration : 0);

      const pendingRestoreTime = pendingRestoreTimeRef.current;
      if (pendingRestoreTime !== null && Number.isFinite(loadedDuration)) {
        const restoredTime = Math.min(pendingRestoreTime, loadedDuration);
        event.currentTarget.currentTime = restoredTime;
        setCurrentTime(restoredTime);
        pendingRestoreTimeRef.current = null;
      }

      setIsSessionRestored(true);
    },
    [],
  );

  const onTimeUpdate = useCallback(
    (deck: Deck, event: SyntheticEvent<HTMLAudioElement>) => {
      if (deck === activeDeckRef.current && pendingRestoreTimeRef.current === null) {
        setCurrentTime(event.currentTarget.currentTime);
      }
    },
    [],
  );

  const onDurationChange = useCallback(
    (deck: Deck, event: SyntheticEvent<HTMLAudioElement>) => {
      if (deck !== activeDeckRef.current) return;

      const updatedDuration = event.currentTarget.duration;
      if (Number.isFinite(updatedDuration)) {
        setDuration(updatedDuration);
      }
    },
    [],
  );

  const onCanPlay = useCallback(
    (deck: Deck) => {
      if (
        deck === activeDeckRef.current &&
        pendingPlaybackDeckRef.current === deck
      ) {
        requestDeckPlayback(deck);
      }
    },
    [requestDeckPlayback],
  );

  const onPlaying = useCallback((deck: Deck) => {
    if (deck === activeDeckRef.current) {
      pendingPlaybackDeckRef.current = null;
      setIsPlaying(true);
    }
  }, []);

  const onPause = useCallback((deck: Deck) => {
    if (deck === activeDeckRef.current) setIsPlaying(false);
  }, []);

  const onEnded = useCallback(
    (deck: Deck) => {
      if (deck === activeDeckRef.current) {
        const nextTrack = queueNavigationRef.current.completeCurrent();
        if (!nextTrack) {
          clearPlayback();
          return;
        }
        const nextIndex = trackPosition(tracksRef.current, nextTrack.globalId);
        if (nextIndex >= 0) switchToTrack(nextIndex, true);
      }
    },
    [clearPlayback, switchToTrack],
  );

  useEffect(() => {
    if (restoreStartedRef.current) return;
    const restored = playbackRestore(tracks, initialPlaybackRef.current);
    if (!restored) return;
    restoreStartedRef.current = true;
    const initialTrack = restored.track;
    const initialTrackIndex = trackPosition(tracks, initialTrack.globalId);

    activeDeckRef.current = 0;
    currentTrackIdRef.current = initialTrack.globalId;
    pendingRestoreTimeRef.current = restored.position;
    setCurrentTrackId(initialTrack.globalId);
    setCurrentTime(restored.position);
    setDuration(initialTrack.durationSeconds);
    setIsPlaying(false);
    setIsSessionRestored(false);

    releaseDeck(0);
    releaseDeck(1);

    if (usesNativeAudio) {
      pendingRestoreTimeRef.current = null;
      loadNativeTrack(initialTrack, restored.position, false);
      return;
    }

    prepareDeck(0, initialTrackIndex);
    if (tracks.length > 1) {
      prepareDeck(1, (initialTrackIndex + 1) % tracks.length);
    }
  }, [tracks, loadNativeTrack, prepareDeck, releaseDeck, usesNativeAudio]);

  const queuedNextTrackId = queueNavigation.nextTrack?.globalId ?? null;
  useEffect(() => {
    if (!currentTrack) return;

    const nextTrack = queueNavigationRef.current.peekNext();
    if (usesNativeAudio) {
      if (!isSessionRestored || !nextTrack) return;
      void nativeCommandsRef.current.run("queue_native_audio", {
        source: nativeAudioSource(nextTrack),
      }).catch((error) =>
        console.warn("Could not preload the next native track:", error),
      );
      return;
    }

    const inactiveDeck: Deck = activeDeckRef.current === 0 ? 1 : 0;
    if (!nextTrack) {
      releaseDeck(inactiveDeck);
      return;
    }
    const nextIndex = trackPosition(tracksRef.current, nextTrack.globalId);
    if (nextIndex >= 0) prepareDeck(inactiveDeck, nextIndex);
  }, [
    currentTrack,
    isSessionRestored,
    prepareDeck,
    queuedNextTrackId,
    releaseDeck,
    usesNativeAudio,
  ]);

  useEffect(() => {
    if (!usesNativeAudio || !currentTrack) return;

    let disposed = false;
    let handledEnd = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const statusGeneration = nativeLoadGenerationRef.current;
      const commandRevision = nativeCommandsRef.current.revision;
      if (
        nativeCommandsRef.current.pending > 0 ||
        nativeReadyGenerationRef.current !== statusGeneration
      ) {
        timer = setTimeout(poll, 200);
        return;
      }

      try {
        const playback = await invoke<NativeAudioStatus>("native_audio_status");
        if (disposed) return;

        if (
          !nativeCommandsRef.current.acceptsStatus(commandRevision) ||
          statusGeneration !== nativeLoadGenerationRef.current ||
          nativeReadyGenerationRef.current !== statusGeneration
        ) {
          timer = setTimeout(poll, 200);
          return;
        }

        const statusTrack = trackForNativeAudioStatus(
          tracksRef.current,
          currentTrackIdRef.current,
          queueNavigationRef.current.peekNext(),
          playback.currentSource,
        );
        if (!statusTrack) {
          timer = setTimeout(poll, 200);
          return;
        }

        if (statusTrack.advanced) {
          const advancedTrack = statusTrack.track;
          queueNavigationRef.current.next();
          currentTrackIdRef.current = advancedTrack.globalId;
          setCurrentTrackId(advancedTrack.globalId);
          setDuration(advancedTrack.durationSeconds);

          const followingTrack = queueNavigationRef.current.peekNext();
          if (followingTrack) {
            void nativeCommandsRef.current.run("queue_native_audio", {
              source: nativeAudioSource(followingTrack),
            }).catch((error) =>
              console.warn("Could not preload the next native track:", error),
            );
          }
        }

        setCurrentTime(playback.currentTime);
        if (playback.duration > 0) setDuration(playback.duration);
        if (playback.ended || playback.error) {
          nativePlayIntentRef.current = false;
        }
        // Keep the pause control active through a short rebuffer. The native
        // worker still intends to play and will resume by itself.
        setIsPlaying(
          playback.isPlaying || (playback.buffering && nativePlayIntentRef.current),
        );

        if (playback.ended && !handledEnd) {
          handledEnd = true;
          const nextTrack = queueNavigationRef.current.completeCurrent();
          if (nextTrack) {
            const nextIndex = trackPosition(
              tracksRef.current,
              nextTrack.globalId,
            );
            if (nextIndex >= 0) switchToTrack(nextIndex, true);
          } else {
            clearPlayback();
          }
          return;
        }
      } catch (error) {
        if (!disposed)
          console.warn("Could not read native audio state:", error);
      }

      if (!disposed) timer = setTimeout(poll, 200);
    };

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [clearPlayback, currentTrack, switchToTrack, usesNativeAudio]);

  useEffect(
    () => () => {
      dashPlayersRef.current[0]?.reset();
      dashPlayersRef.current[1]?.reset();
    },
    [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isUnmodifiedKey(event, "Space")) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest("input, textarea, select, [contenteditable='true']"))
      ) {
        return;
      }

      event.preventDefault();
      if (!event.repeat) void togglePlayback();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlayback]);

  useEffect(() => {
    if (usesNativeAudio || !("mediaSession" in navigator)) return;

    const mediaSession = navigator.mediaSession;
    const register = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler,
    ) => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch (error) {
        console.warn(`Media action ${action} is unavailable:`, error);
      }
    };

    register("play", () => runRemoteAction("play", playActive));
    register("pause", () => runRemoteAction("pause", pauseActive));
    register("nexttrack", () => runRemoteAction("next", next));
    register("previoustrack", () => runRemoteAction("previous", previous));

    return () => {
      for (const action of [
        "play",
        "pause",
        "nexttrack",
        "previoustrack",
      ] as MediaSessionAction[]) {
        try {
          mediaSession.setActionHandler(action, null);
        } catch {
          // Some WebKit versions expose Media Session but not every action.
        }
      }
    };
  }, [
    next,
    pauseActive,
    playActive,
    previous,
    runRemoteAction,
    usesNativeAudio,
  ]);

  useEffect(() => {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState =
        usesNativeAudio || !currentTrack
          ? "none"
          : isPlaying
            ? "playing"
            : "paused";
    }
  }, [currentTrack, isPlaying, usesNativeAudio]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (!currentTrack) {
      navigator.mediaSession.metadata = null;
      return;
    }
    if (usesNativeAudio) {
      navigator.mediaSession.metadata = null;
      return;
    }

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.name,
        artist: currentTrack.artist,
        album: currentTrack.album,
        artwork: [{ src: currentTrack.cover }],
      });
    } catch (error) {
      console.warn("Could not publish WebKit media artwork:", error);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.name,
        artist: currentTrack.artist,
        album: currentTrack.album,
      });
    }
  }, [currentTrack, usesNativeAudio]);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let stopListening: (() => void) | undefined;

    void listen<string>("native-media-control", ({ payload }) => {
      switch (payload) {
        case "play":
          runRemoteAction("play", playActive);
          break;
        case "pause":
          runRemoteAction("pause", pauseActive);
          break;
        case "toggle":
          runRemoteAction("toggle", () => void togglePlayback());
          break;
        case "next":
          runRemoteAction("next", next);
          break;
        case "previous":
          runRemoteAction("previous", previous);
          break;
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [
    next,
    pauseActive,
    playActive,
    previous,
    runRemoteAction,
    togglePlayback,
  ]);

  useEffect(() => {
    if (!isTauri() || !currentTrack) return;

    void invoke("set_native_media_metadata", {
      metadata: {
        title: currentTrack.name,
        artist: currentTrack.artist,
        album: currentTrack.album,
        durationSeconds: currentTrack.durationSeconds,
        coverSource: currentTrack.nativeCover,
        assetSource: nativeAudioSource(currentTrack),
      },
    }).catch((error) => console.warn("Could not update Now Playing:", error));
  }, [currentTrack]);

  useEffect(() => {
    if (!isTauri()) return;

    void invoke("set_native_media_commands_enabled", {
      enabled:
        currentTrack !== undefined &&
        (usesNativeAudio || currentTrack.provider === "local"),
    }).catch((error) =>
      console.warn("Could not switch native media command ownership:", error),
    );
  }, [currentTrack, usesNativeAudio]);

  const nativePositionSeconds = Math.floor(currentTime);
  useEffect(() => {
    if (!isTauri()) return;

    void invoke("set_native_media_playback", {
      isPlaying: currentTrack !== undefined && isPlaying,
      positionSeconds: nativePositionSeconds,
    }).catch((error) =>
      console.warn("Could not update native playback state:", error),
    );
  }, [currentTrack, isPlaying, nativePositionSeconds]);

  return {
    playTrack,
    clear: stopPlayback,
    currentTrack,
    currentTime,
    duration,
    isPlaying,
    isSessionRestored,
    togglePlayback,
    previous,
    next,
    seek,
    audioDecks: {
      firstAudioRef,
      secondAudioRef,
      onLoadedMetadata,
      onDurationChange,
      onTimeUpdate,
      onCanPlay,
      onPlaying,
      onPause,
      onEnded,
    },
  };
}
