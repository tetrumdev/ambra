import { categoryOrder, rankArtists, rankAlbums } from "./catalogRanking";
import type { CatalogArtist, CatalogAlbum, SearchPage, StreamingProvider } from "../api/server";
import type { Track } from "../types/music";
import { deduplicateSearchResults, rankSearchResults } from "./searchRanking";

export type SearchSnapshot = {
  results: Track[];
  artists: CatalogArtist[];
  albums: CatalogAlbum[];
  candidates: Track[];
  isSearching: boolean;
  hasMore: boolean;
  error: string | null;
  canRetry: boolean;
};

type Source = {
  tracks: Map<string, Track>;
  artists: CatalogArtist[];
  albums: CatalogAlbum[];
  nextOffset: number | null;
  pending: boolean;
  error: string | null;
};

type Options = {
  query: string;
  providers: StreamingProvider[];
  combined: boolean;
  fetchPage: (query: string, provider: StreamingProvider, signal: AbortSignal, offset: number, limit: number) => Promise<SearchPage>;
  onUpdate: (snapshot: SearchSnapshot) => void;
  timeoutMs?: number;
  initialMergeWindowMs?: number;
  initialDeadlineMs?: number;
};

// One cursor and failure state per source. No service gates another service's results.
export class SearchSession {
  private sources = new Map<StreamingProvider, Source>();
  private controller = new AbortController();
  private initialResultsReleased = false;
  private started = false;
  private mergeTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private options: Options) {
    for (const provider of [...new Set(options.providers)].sort()) {
      this.sources.set(provider, { tracks: new Map(), artists: [], albums: [], nextOffset: 0, pending: false, error: null });
    }
  }

  snapshot(): SearchSnapshot {
    const sources = [...this.sources.values()];
    const candidates = sources.flatMap(source => [...source.tracks.values()]);
    const results = this.options.combined ? rankSearchResults(candidates, this.options.query) : deduplicateSearchResults(candidates);
    const artistCandidates = sources.flatMap(source => source.artists);
    const albumCandidates = sources.flatMap(source => source.albums);
    const intent = categoryOrder(this.options.query, results, artistCandidates, albumCandidates, candidates)[0];
    const albums = rankAlbums(albumCandidates, this.options.query, intent === "albums" ? [] : results);
    const artists = rankArtists(artistCandidates, intent === "albums" && albums[0] ? albums[0].artist : this.options.query, intent === "albums" ? [] : results);
    const errors = [...this.sources].filter(([, source]) => source.error)
      .map(([provider, source]) => `${provider}: ${source.error}`);
    return {
      candidates,
      artists,
      albums,
      results,
      isSearching: sources.some(source => source.pending),
      hasMore: sources.some(source => source.nextOffset !== null && !source.error),
      error: this.sources.size === 0 ? "No music services are connected." : errors.length ? `Some services could not be searched (${errors.join("; ")}).` : null,
      canRetry: errors.length > 0,
    };
  }

  private releaseInitialResults = () => {
    this.initialResultsReleased = true;
    clearTimeout(this.mergeTimer);
    clearTimeout(this.deadlineTimer);
    this.publish();
  };

  private publish() {
    if (this.controller.signal.aborted) return;
    const next = this.snapshot();
    if (!next.isSearching) {
      this.initialResultsReleased = true;
      clearTimeout(this.mergeTimer);
      clearTimeout(this.deadlineTimer);
    }
    if (!this.initialResultsReleased && (next.candidates.length > 0 || next.artists.length > 0 || next.albums.length > 0)) {
      const delay = this.options.initialMergeWindowMs ?? 120;
      if (delay === 0) this.initialResultsReleased = true;
      else if (!this.mergeTimer) this.mergeTimer = setTimeout(this.releaseInitialResults, delay);
    }
    // The first visible list is consolidated when sources finish close together.
    // A slow/offline source can delay useful results by at most the bounded grace period.
    this.options.onUpdate(this.initialResultsReleased ? next : { ...next, results: [], candidates: [], artists: [], albums: [] });
  }

  replaceTrack(track: Track) {
    for (const source of this.sources.values()) {
      if (source.tracks.has(track.globalId)) source.tracks.set(track.globalId, track);
    }
    this.publish();
  }

  async loadMore() {
    if (this.controller.signal.aborted) return;
    if (!this.started) {
      this.started = true;
      this.deadlineTimer = setTimeout(this.releaseInitialResults, this.options.initialDeadlineMs ?? 500);
    }
    const ready = [...this.sources].filter(([, source]) => source.nextOffset !== null && !source.pending && !source.error);
    for (const [, source] of ready) source.pending = true;
    this.publish();
    await Promise.all(ready.map(async ([provider, source]) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      this.controller.signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, this.options.timeoutMs ?? 8000);
      let rejectAbort: () => void = () => {};
      try {
        const offset = source.nextOffset!;
        const aborted = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(new Error("Search timed out"));
          controller.signal.addEventListener("abort", rejectAbort, { once: true });
          if (controller.signal.aborted) rejectAbort();
        });
        const page = await Promise.race([
          this.options.fetchPage(this.options.query, provider, controller.signal, offset, offset === 0 ? 20 : 40),
          aborted,
        ]);
        if (this.controller.signal.aborted) return;
        if (page.nextOffset !== null && (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset)) {
          throw new Error("Invalid pagination cursor");
        }
        for (const track of page.tracks) source.tracks.set(track.globalId, track);
        source.artists.push(...page.artists ?? []);
        source.albums.push(...page.albums ?? []);
        source.nextOffset = page.nextOffset;
      } catch (error) {
        if (!this.controller.signal.aborted) source.error = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", rejectAbort);
        this.controller.signal.removeEventListener("abort", cancel);
        source.pending = false;
        this.publish();
      }
    }));
  }

  async retry() {
    for (const source of this.sources.values()) source.error = null;
    await this.loadMore();
  }

  cancel() {
    clearTimeout(this.mergeTimer);
    clearTimeout(this.deadlineTimer);
    this.controller.abort();
  }
}
