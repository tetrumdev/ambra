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

/** The songs of `tracks` the page filter lets through. */
export function usePageFilteredTracks<T extends Track>(tracks: T[]) {
  const { terms } = usePageFilter();
  const filtering = terms.length > 0;
  const shown = useMemo(() => filtering ? tracks.filter(track => trackMatches(track, terms)) : tracks, [tracks, terms, filtering]);
  useReportPageMatches(filtering ? shown.length : null);
  return { shown, filtering };
}
