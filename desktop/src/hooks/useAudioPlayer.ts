import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent,
} from "react";
import type { Deck, Track } from "../types/music";

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
  onPlay: (deck: Deck) => void;
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
  playTrack: (trackIndex: number) => void;
};

type InitialPlayback = {
  trackId: string | null;
  positionSeconds: number;
};

export function useAudioPlayer(
  tracks: Track[],
  initialPlayback: InitialPlayback,
): AudioPlayer {
  const firstAudioRef = useRef<HTMLAudioElement>(null);
  const secondAudioRef = useRef<HTMLAudioElement>(null);
  const tracksRef = useRef<Track[]>(tracks);
  const activeDeckRef = useRef<Deck>(0);
  const nowPlayingRef = useRef(0);
  const initialPlaybackRef = useRef(initialPlayback);
  const pendingRestoreTimeRef = useRef<number | null>(null);

  const [nowPlaying, setNowPlaying] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSessionRestored, setIsSessionRestored] = useState(false);

  tracksRef.current = tracks;
  const currentTrack = tracks[nowPlaying];

  const audioForDeck = useCallback(
    (deck: Deck) =>
      deck === 0 ? firstAudioRef.current : secondAudioRef.current,
    [],
  );

  const activeAudio = useCallback(
    () => audioForDeck(activeDeckRef.current),
    [audioForDeck],
  );

  const prepareDeck = useCallback(
    (deck: Deck, trackIndex: number) => {
      const audio = audioForDeck(deck);
      const track = tracksRef.current[trackIndex];

      if (!audio || !track) return;
      if (audio.dataset.trackIndex === String(trackIndex)) return;

      audio.pause();
      audio.src = track.audio;
      audio.dataset.trackIndex = String(trackIndex);
      audio.load();
    },
    [audioForDeck],
  );

  const switchToTrack = useCallback(
    (requestedIndex: number, shouldPlay: boolean) => {
      const library = tracksRef.current;
      if (library.length === 0) return;

      pendingRestoreTimeRef.current = null;

      const targetIndex =
        ((requestedIndex % library.length) + library.length) % library.length;
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
      nowPlayingRef.current = targetIndex;

      setNowPlaying(targetIndex);
      setCurrentTime(0);
      setDuration(
        Number.isFinite(incomingAudio.duration) ? incomingAudio.duration : 0,
      );
      setIsPlaying(shouldPlay);

      if (shouldPlay) {
        void incomingAudio.play().catch((error) => {
          setIsPlaying(false);
          console.error("Could not continue playback:", error);
        });
      }

      const followingIndex = (targetIndex + 1) % library.length;
      prepareDeck(outgoingDeck, followingIndex);
    },
    [audioForDeck, prepareDeck],
  );

  const seek = useCallback(
    (time: number) => {
      const audio = activeAudio();
      if (!audio) return;

      audio.currentTime = time;
      setCurrentTime(time);
    },
    [activeAudio],
  );

  const togglePlayback = useCallback(async () => {
    const audio = activeAudio();
    if (!audio) return;

    if (!audio.paused) {
      audio.pause();
      return;
    }

    try {
      await audio.play();
    } catch (error) {
      console.error("Could not play audio:", error);
    }
  }, [activeAudio]);

  const playTrack = useCallback(
    (trackIndex: number) => {
      switchToTrack(trackIndex, true);
    },
    [switchToTrack],
  );

  const previous = useCallback(() => {
    const audio = activeAudio();
    if (!audio) return;

    if (audio.currentTime > 3) {
      seek(0);
      return;
    }

    switchToTrack(nowPlayingRef.current - 1, !audio.paused);
  }, [activeAudio, seek, switchToTrack]);

  const next = useCallback(() => {
    const audio = activeAudio();
    if (!audio) return;

    switchToTrack(nowPlayingRef.current + 1, !audio.paused && !audio.ended);
  }, [activeAudio, switchToTrack]);

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

  const onPlay = useCallback((deck: Deck) => {
    if (deck === activeDeckRef.current) setIsPlaying(true);
  }, []);

  const onPause = useCallback((deck: Deck) => {
    if (deck === activeDeckRef.current) setIsPlaying(false);
  }, []);

  const onEnded = useCallback(
    (deck: Deck) => {
      if (deck === activeDeckRef.current) {
        switchToTrack(nowPlayingRef.current + 1, true);
      }
    },
    [switchToTrack],
  );

  useEffect(() => {
    if (tracks.length === 0) return;

    const savedPlayback = initialPlaybackRef.current;
    const savedTrackIndex = tracks.findIndex(
      (track) => track.id === savedPlayback.trackId,
    );
    const initialTrackIndex = savedTrackIndex >= 0 ? savedTrackIndex : 0;

    activeDeckRef.current = 0;
    nowPlayingRef.current = initialTrackIndex;
    pendingRestoreTimeRef.current =
      savedTrackIndex >= 0 ? savedPlayback.positionSeconds : 0;
    setNowPlaying(initialTrackIndex);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setIsSessionRestored(false);

    for (const audio of [firstAudioRef.current, secondAudioRef.current]) {
      audio?.pause();
      delete audio?.dataset.trackIndex;
    }

    prepareDeck(0, initialTrackIndex);
    prepareDeck(1, (initialTrackIndex + 1) % tracks.length);
  }, [prepareDeck, tracks]);

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
    if (!("mediaSession" in navigator)) return;

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

    register("play", () => void activeAudio()?.play());
    register("pause", () => activeAudio()?.pause());
    register("nexttrack", next);
    register("previoustrack", previous);

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
  }, [activeAudio, next, previous]);

  useEffect(() => {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    }
  }, [isPlaying]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentTrack) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.name,
      artist: currentTrack.artist,
      album: currentTrack.album,
      artwork: [{ src: currentTrack.cover }],
    });
  }, [currentTrack]);

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
      onPlay,
      onPause,
      onEnded,
    },
  };
}
