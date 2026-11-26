import { createContext, useContext } from "react";
import type { PanGesture } from "react-native-gesture-handler";

/**
 * The page swipe (between tabs, or back). Rows that swipe for their own actions block it, so a
 * sideways swipe on a song acts on the song and anywhere else moves between pages.
 */
export const PageGestureContext = createContext<PanGesture | null>(null);
export const usePageGesture = () => useContext(PageGestureContext);
