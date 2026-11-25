import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { GlobalTrackId, Track } from "../types/music";
import type { TrackReveal } from "../utils/browse";
import { filterTerms, trackMatches } from "../utils/trackFilter";

type PageFilterStore = {
  query: string;
  terms: readonly string[];
  /** Songs each list on the page shows while filtering, keyed by list. */
  reportMatches: (list: string, count: number | null) => void;
  matches: number;
};

const noTerms: readonly string[] = [];
const PageFilterContext = createContext<PageFilterStore>({ query: "", terms: noTerms, reportMatches: () => {}, matches: 0 });
export const usePageFilter = () => useContext(PageFilterContext);

/** Filters the song lists of the page it wraps by `query`; an empty query shows everything. */
export function PageFilterProvider({ query, children }: { query: string; children: ReactNode }) {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const terms = useMemo(() => query.trim() ? filterTerms(query) : noTerms, [query]);
  const reportMatches = useCallback((list: string, count: number | null) => setCounts(current => {
    if (current.get(list) === (count ?? undefined)) return current;
    const next = new Map(current);
    if (count === null) next.delete(list);
    else next.set(list, count);
    return next;
  }), []);
  const matches = useMemo(() => [...counts.values()].reduce((total, count) => total + count, 0), [counts]);
  const value = useMemo(() => ({ query, terms, reportMatches, matches }), [query, terms, reportMatches, matches]);
  return <PageFilterContext.Provider value={value}>{children}</PageFilterContext.Provider>;
}

/** Tells the filter bar how many songs this list shows, for as long as the list is filtered. */
export function useReportPageMatches(count: number | null) {
  const list = useId();
  const { reportMatches } = usePageFilter();
  useEffect(() => reportMatches(list, count), [list, count, reportMatches]);
  useEffect(() => () => reportMatches(list, null), [list, reportMatches]);
}

type RevealKey = string | TrackReveal;

type PageReveal = {
  /** The song to show in place among its neighbors. */
  target: GlobalTrackId | null;
  /** Identifies a reveal so the list scrolls to the song once. */
  key: RevealKey | null;
  /** True until the listener scrolls, clicks or presses a key outside the filter. */
  highlighted: boolean;
};

/** Keys that move nothing on the page, so pressing them leaves the found song highlighted. */
const QUIET_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Escape", "Enter", "Tab"]);

function usePageReveal(target: GlobalTrackId | null, key: RevealKey | null): PageReveal {
  const [dismissed, setDismissed] = useState<RevealKey | null>(null);
  const highlighted = key !== null && dismissed !== key;
  useEffect(() => {
    if (!highlighted) return;
    // The list's own jump to the match is a scroll too, so only the listener's input counts:
    // anything done in the filter bar itself (typing, Enter, closing it) keeps the highlight.
    const inFilter = (event: Event) => event.target instanceof Element && event.target.closest(".pageFilter") !== null;
    const dismiss = (event: Event) => {
      if (inFilter(event)) return;
      if (event instanceof KeyboardEvent && QUIET_KEYS.has(event.key)) return;
      setDismissed(key);
    };
    const events = ["pointerdown", "wheel", "keydown", "touchmove"] as const;
    for (const event of events) window.addEventListener(event, dismiss, { capture: true, passive: true });
    return () => { for (const event of events) window.removeEventListener(event, dismiss, { capture: true }); };
  }, [highlighted, key]);
  return { target, key, highlighted };
}

/** Keep a song among its neighbors when navigation or a single filter match reveals it. */
export function usePageFilteredTracks<T extends Track>(tracks: T[], revealTrack?: TrackReveal) {
  const { terms, matches, query } = usePageFilter();
  const filtering = terms.length > 0;
  const matched = useMemo(() => filtering ? tracks.filter(track => trackMatches(track, terms)) : tracks, [tracks, terms, filtering]);
  useReportPageMatches(filtering ? matched.length : null);
  const filterTarget = filtering && matches === 1 && matched.length === 1 ? matched[0].globalId : null;
  const trackToReveal = !filtering && revealTrack && tracks.some(track => track.globalId === revealTrack.trackId)
    ? revealTrack : null;
  const filterReveal = usePageReveal(filterTarget, filterTarget ? `${query}\n${filterTarget}` : null);
  const navigationReveal = usePageReveal(trackToReveal?.trackId ?? null, trackToReveal);
  return {
    shown: filterTarget ? tracks : matched,
    filtering: filtering && !filterTarget,
    reveal: filtering ? filterReveal : navigationReveal,
  };
}
