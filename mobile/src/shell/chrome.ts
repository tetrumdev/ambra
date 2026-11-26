import { makeMutable, withSpring } from "react-native-reanimated";
import { springs } from "../theme";

/**
 * How many sheets cover the app. The app behind them recedes a little with each one, like a
 * card pushed back, so it stays clear what a swipe down on the sheet will return to.
 */
export const sheetDepth = makeMutable(0);
let depth = 0;

/** Call when a sheet starts opening; returns the call for when it has closed. */
export function coverWithSheet() {
  depth += 1;
  sheetDepth.set(withSpring(depth, springs.settle));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth = Math.max(0, depth - 1);
    sheetDepth.set(withSpring(depth, springs.settle));
  };
}

/** A sheet being dragged away gives back the app behind it as it goes (0 to 1). */
export function previewUncover(progress: number) {
  sheetDepth.set(Math.max(0, depth - Math.min(1, Math.max(0, progress))));
}
