import { createContext, useContext } from "react";
import type { GlobalTrackId } from "../types/music";
import type { OptionalColumnKey } from "../utils/trackColumnWidths";
import type { TrackPlayStats } from "./useListeningHistory";

export type TrackColumnsStore = {
  /** Optional columns every track list shows, in display order. */
  extra: readonly OptionalColumnKey[];
  setExtra: (columns: OptionalColumnKey[]) => void;
  stats: ReadonlyMap<GlobalTrackId, TrackPlayStats>;
};

const noStats = new Map<GlobalTrackId, TrackPlayStats>();
export const TrackColumnsContext = createContext<TrackColumnsStore>({ extra: [], setExtra: () => {}, stats: noStats });
export const useTrackColumns = () => useContext(TrackColumnsContext);
