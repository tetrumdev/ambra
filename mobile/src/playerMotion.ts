import { Easing } from "react-native-reanimated";

// Matches desktop/src/utils/motion.ts and BigscreenArtwork.css.
export const playerTiming = { duration: 500, easing: Easing.bezier(0.4, 0, 0, 1) };
export const coverFadeTiming = { duration: 400, easing: Easing.bezier(0.25, 0.1, 0.25, 1) };
export const COVER_TRAVEL = 0.09;
export const COVER_SCALE = 0.94;
export const SONG_TRAVEL = 14;

export type SkipDirection = () => number;
