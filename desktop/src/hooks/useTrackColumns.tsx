import { createContext, useContext } from "react";
import type { GlobalTrackId } from "../types/music";
import type { ColumnKey, HideableColumnKey, OptionalColumnKey } from "../utils/trackColumnWidths";
import type { TrackPlayStats } from "./useListeningHistory";

export type TrackColumnsStore = {
  /** Optional columns every track list shows, in display order. */
  extra: readonly OptionalColumnKey[];
  setExtra: (columns: OptionalColumnKey[]) => void;
  /** Standard columns every track list leaves out. */
  hidden: readonly HideableColumnKey[];
  setHidden: (columns: HideableColumnKey[]) => void;
  /** Columns omitted by the current page, without changing the saved choices. */
  excluded?: readonly ColumnKey[];
  stats: ReadonlyMap<GlobalTrackId, TrackPlayStats>;
};

const noStats = new Map<GlobalTrackId, TrackPlayStats>();
export const TrackColumnsContext = createContext<TrackColumnsStore>({ extra: [], setExtra: () => {}, hidden: [], setHidden: () => {}, stats: noStats });
export const useTrackColumns = () => useContext(TrackColumnsContext);
