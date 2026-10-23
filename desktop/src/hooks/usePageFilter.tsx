import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { Track } from "../types/music";
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

export type PageReveal = {
  /** The page's only match, shown in place rather than on its own; null otherwise. */
  target: string | null;
  /** Changes each time the match is found anew, so the list scrolls to it once per find. */
  key: string | null;
  /** True until the listener clicks, scrolls or types after it was found. */
  breathing: boolean;
};

/**
 * When the whole page has one match, a list that holds it keeps all its songs and points at
 * that one instead of narrowing to it. `matchedIds` are this list's matches.
 */
export function usePageReveal(matchedIds: readonly string[], filtering: boolean): PageReveal {
  const { matches, query } = usePageFilter();
  const target = filtering && matches === 1 && matchedIds.length === 1 ? matchedIds[0] : null;
  const key = target === null ? null : `${query}\n${target}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const breathing = key !== null && dismissed !== key;
  useEffect(() => {
    if (!breathing) return;
    const dismiss = () => setDismissed(key);
    const events = ["pointerdown", "wheel", "keydown", "touchstart"] as const;
    for (const event of events) window.addEventListener(event, dismiss, { capture: true, passive: true });
    return () => { for (const event of events) window.removeEventListener(event, dismiss, { capture: true }); };
  }, [breathing, key]);
  return { target, key, breathing };
}

/** The songs of `tracks` the page filter lets through, or all of them around the page's only match. */
export function usePageFilteredTracks<T extends Track>(tracks: T[]) {
  const { terms } = usePageFilter();
  const filtering = terms.length > 0;
  const matched = useMemo(() => filtering ? tracks.filter(track => trackMatches(track, terms)) : tracks, [tracks, terms, filtering]);
  const matchedIds = useMemo(() => filtering ? matched.map(track => track.globalId) : [], [matched, filtering]);
  useReportPageMatches(filtering ? matched.length : null);
  const reveal = usePageReveal(matchedIds, filtering);
  return { shown: reveal.target ? tracks : matched, filtering: filtering && !reveal.target, reveal };
}
