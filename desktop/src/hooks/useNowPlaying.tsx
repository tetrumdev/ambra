import { createContext, useContext, useMemo, type ReactNode } from "react";

type NowPlaying = {
  /** The song the player has loaded, playing or paused. */
  trackId: string | undefined;
  isPlaying: boolean;
  togglePlayback: () => void;
};

const NowPlayingContext = createContext<NowPlaying>({ trackId: undefined, isPlaying: false, togglePlayback: () => {} });

/** Lets every song list mark the song that is playing, and pause or resume it in place. */
export function NowPlayingProvider({ trackId, isPlaying, togglePlayback, children }: NowPlaying & { children: ReactNode }) {
  const value = useMemo(() => ({ trackId, isPlaying, togglePlayback }), [trackId, isPlaying, togglePlayback]);
  return <NowPlayingContext.Provider value={value}>{children}</NowPlayingContext.Provider>;
}

export const useNowPlaying = () => useContext(NowPlayingContext);

/** How a song in a list relates to the player: "playing", "paused" (loaded but paused), or not at all. */
export type NowPlayingState = "playing" | "paused" | undefined;

export function nowPlayingState(nowPlaying: NowPlaying, trackId: string): NowPlayingState {
  if (nowPlaying.trackId !== trackId) return undefined;
  return nowPlaying.isPlaying ? "playing" : "paused";
}
