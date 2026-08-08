import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { MediaPlayer, type MediaPlayerClass } from "dashjs";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Deck, Track } from "../types/music";
import { canAttemptPlayback } from "../utils/playbackReadiness";
import {
  nativeAudioQueue,
  nativeAudioSource,
  trackForNativeAudioSource,
} from "../utils/nativeAudioSource";
import { trackPosition } from "../utils/trackOrder";

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
  playTrack: (trackId: string) => void;
};

type InitialPlayback = {
  trackId: string | null;
  positionSeconds: number;
};

type NativeAudioStatus = {
  currentSource: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  ended: boolean;
};

export function useAudioPlayer(
  tracks: Track[],
  initialPlayback: InitialPlayback,
): AudioPlayer {
  const firstAudioRef = useRef<HTMLAudioElement>(null);
  const secondAudioRef = useRef<HTMLAudioElement>(null);
  const tracksRef = useRef<Track[]>(tracks);
  const activeDeckRef = useRef<Deck>(0);
  const currentTrackIdRef = useRef<string | null>(null);
  const currentTimeRef = useRef(0);
  const isPlayingRef = useRef(false);
  const initialPlaybackRef = useRef(initialPlayback);
  const pendingRestoreTimeRef = useRef<number | null>(null);
  const pendingPlaybackDeckRef = useRef<Deck | null>(null);
  const lastRemoteActionRef = useRef({ action: "", timestamp: 0 });
  const deckPlaybackKindsRef = useRef<Array<Track["playbackKind"] | null>>([
    null,
    null,
  ]);
  const dashPlayersRef = useRef<Array<MediaPlayerClass | null>>([null, null]);

  const [currentTrackId, setCurrentTrackId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSessionRestored, setIsSessionRestored] = useState(false);

  tracksRef.current = tracks;
  currentTimeRef.current = currentTime;
  isPlayingRef.current = isPlaying;
  const usesNativeAudio = isTauri();
  const hasTracks = tracks.length > 0;
  const currentTrack =
    tracks.find((track) => track.globalId === currentTrackId) ?? tracks[0];

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
        const dashPlayer = MediaPlayer().create();
        dashPlayersRef.current[deck] = dashPlayer;
        dashPlayer.initialize(audio, track.audio, false);
      } else {
        audio.src = track.audio;
        audio.load();
      }
    },
    [audioForDeck, releaseDeck, usesNativeAudio],
  );

  const loadNativeTrack = useCallback(
    (track: Track, positionSeconds: number, autoplay: boolean) => {
      const queue = nativeAudioQueue(tracksRef.current, track.globalId);
      if (!queue) return;

      void invoke("load_native_audio", {
        source: queue.source,
        nextSource: queue.nextSource,
        positionSeconds,
        autoplay,
      })
        .then(() => setIsSessionRestored(true))
        .catch((error) => console.error("Could not load native audio:", error));
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

  const activeTrackIndex = useCallback(() => {
    const library = tracksRef.current;
    const trackIndex = trackPosition(library, currentTrackIdRef.current);
    return trackIndex >= 0 ? trackIndex : 0;
  }, []);

  const switchToTrack = useCallback(
    (requestedIndex: number, shouldPlay: boolean) => {
      const library = tracksRef.current;
      if (library.length === 0) return;

      pendingRestoreTimeRef.current = null;

      const targetIndex =
        ((requestedIndex % library.length) + library.length) % library.length;
      const targetTrack = library[targetIndex];

      if (usesNativeAudio) {
        currentTrackIdRef.current = targetTrack.globalId;
        setCurrentTrackId(targetTrack.globalId);
        setCurrentTime(0);
        setDuration(targetTrack.durationSeconds);
        setIsPlaying(false);
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

      const followingIndex = (targetIndex + 1) % library.length;
      prepareDeck(outgoingDeck, followingIndex);
    },
    [
      audioForDeck,
      loadNativeTrack,
      prepareDeck,
      requestDeckPlayback,
      usesNativeAudio,
    ],
  );

  const seek = useCallback(
    (time: number) => {
      if (usesNativeAudio) {
        setCurrentTime(time);
        void invoke("seek_native_audio", { positionSeconds: time }).catch(
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
      void invoke("play_native_audio").catch((error) =>
        console.warn("Could not play native audio:", error),
      );
      return;
    }
    requestDeckPlayback(activeDeckRef.current);
  }, [requestDeckPlayback, usesNativeAudio]);

  const pauseActive = useCallback(() => {
    if (usesNativeAudio) {
      void invoke("pause_native_audio").catch((error) =>
        console.warn("Could not pause native audio:", error),
      );
      return;
    }
    pendingPlaybackDeckRef.current = null;
    activeAudio()?.pause();
  }, [activeAudio, usesNativeAudio]);

  const togglePlayback = useCallback(async () => {
    if (usesNativeAudio) {
      if (isPlayingRef.current) pauseActive();
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
    (trackId: string) => {
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
      switchToTrack(activeTrackIndex() - 1, isPlayingRef.current);
      return;
    }

    const audio = activeAudio();
    if (!audio) return;

    if (audio.currentTime > 3) {
      seek(0);
      return;
    }

    const shouldContinue =
      !audio.paused || pendingPlaybackDeckRef.current === activeDeckRef.current;
    switchToTrack(activeTrackIndex() - 1, shouldContinue);
  }, [activeAudio, activeTrackIndex, seek, switchToTrack, usesNativeAudio]);

  const next = useCallback(() => {
    if (usesNativeAudio) {
      switchToTrack(activeTrackIndex() + 1, isPlayingRef.current);
      return;
    }

    const audio = activeAudio();
    if (!audio) return;

    const shouldContinue =
      (!audio.paused ||
        pendingPlaybackDeckRef.current === activeDeckRef.current) &&
      !audio.ended;
    switchToTrack(activeTrackIndex() + 1, shouldContinue);
  }, [activeAudio, activeTrackIndex, switchToTrack, usesNativeAudio]);

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
      if (deck === activeDeckRef.current) {
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
        switchToTrack(activeTrackIndex() + 1, true);
      }
    },
    [activeTrackIndex, switchToTrack],
  );

  useEffect(() => {
    if (!hasTracks) return;

    const savedPlayback = initialPlaybackRef.current;
    const savedTrackIndex = trackPosition(tracks, savedPlayback.trackId);
    const initialTrackIndex = savedTrackIndex >= 0 ? savedTrackIndex : 0;
    const initialTrack = tracks[initialTrackIndex];

    activeDeckRef.current = 0;
    currentTrackIdRef.current = initialTrack.globalId;
    pendingRestoreTimeRef.current =
      savedTrackIndex >= 0 ? savedPlayback.positionSeconds : 0;
    setCurrentTrackId(initialTrack.globalId);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setIsSessionRestored(false);

    releaseDeck(0);
    releaseDeck(1);

    if (usesNativeAudio) {
      const restoredPosition =
        savedTrackIndex >= 0 ? savedPlayback.positionSeconds : 0;
      pendingRestoreTimeRef.current = null;
      setDuration(initialTrack.durationSeconds);
      loadNativeTrack(initialTrack, restoredPosition, false);
      return;
    }

    prepareDeck(0, initialTrackIndex);
    if (tracks.length > 1) {
      prepareDeck(1, (initialTrackIndex + 1) % tracks.length);
    }
  }, [hasTracks, loadNativeTrack, prepareDeck, releaseDeck, usesNativeAudio]);

  useEffect(() => {
    if (!usesNativeAudio || !currentTrack) return;

    let disposed = false;
    let handledEnd = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const playback = await invoke<NativeAudioStatus>("native_audio_status");
        if (disposed) return;

        if (
          playback.currentSource &&
          playback.currentSource !== nativeAudioSource(currentTrack)
        ) {
          const advancedTrack = trackForNativeAudioSource(
            tracksRef.current,
            playback.currentSource,
          );
          if (advancedTrack) {
            currentTrackIdRef.current = advancedTrack.globalId;
            setCurrentTrackId(advancedTrack.globalId);
            setDuration(advancedTrack.durationSeconds);

            const advancedQueue = nativeAudioQueue(
              tracksRef.current,
              advancedTrack.globalId,
            );
            if (advancedQueue) {
              void invoke("queue_native_audio", {
                source: advancedQueue.nextSource,
              }).catch((error) =>
                console.warn("Could not preload the next native track:", error),
              );
            }
          }
        }

        setCurrentTime(playback.currentTime);
        if (playback.duration > 0) setDuration(playback.duration);
        setIsPlaying(playback.isPlaying);

        if (playback.ended && !handledEnd) {
          handledEnd = true;
          switchToTrack(activeTrackIndex() + 1, true);
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
  }, [activeTrackIndex, currentTrack, switchToTrack, usesNativeAudio]);

  useEffect(
    () => () => {
      dashPlayersRef.current[0]?.reset();
      dashPlayersRef.current[1]?.reset();
    },
    [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;

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
      navigator.mediaSession.playbackState = usesNativeAudio
        ? "none"
        : isPlaying
          ? "playing"
          : "paused";
    }
  }, [isPlaying, usesNativeAudio]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentTrack) return;
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
    if (!isTauri() || !currentTrack) return;

    void invoke("set_native_media_commands_enabled", {
      enabled: usesNativeAudio || currentTrack.provider === "local",
    }).catch((error) =>
      console.warn("Could not switch native media command ownership:", error),
    );
  }, [currentTrack, usesNativeAudio]);

  const nativePositionSeconds = Math.floor(currentTime);
  useEffect(() => {
    if (!isTauri() || !currentTrack) return;

    void invoke("set_native_media_playback", {
      isPlaying,
      positionSeconds: nativePositionSeconds,
    }).catch((error) =>
      console.warn("Could not update native playback state:", error),
    );
  }, [currentTrack, isPlaying, nativePositionSeconds]);

  return {
    playTrack,
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
