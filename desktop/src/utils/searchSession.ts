import { categoryOrder, rankArtists, rankAlbums, searchText, searchTrackTitle } from "./catalogRanking";
import type { CatalogArtist, CatalogAlbum, SearchPage, StreamingProvider } from "../api/server";
import type { Track } from "../types/music";
import { albumTitleFamily, everyCopy, groupSearchResults, rankSearchGroups, sameRecording, type RecordingGroup } from "./searchRanking";
import { musicProviderName } from "./musicProviderName";

export type SearchSnapshot = {
  results: Track[];
  /** Every copy found, services and editions included, grouped by recording. */
  allResults: Track[];
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
  /**
   * The songs on an album. A service's catalog search can find a song's release as an album
   * while leaving the song itself out of its track hits; leading songs are looked for there.
   */
  albumTracks?: (album: CatalogAlbum, signal: AbortSignal) => Promise<Track[]>;
};

/** How many leading songs are looked for on the services that didn't return them. */
const COMPLETED_GROUPS = 5;
/** Extra requests per search, at most. */
const MAX_COMPLETIONS = 10;

// Sources keep independent cursors and failures; the first display waits briefly
// for a combined result set so provider timing doesn't immediately swap cards.
export class SearchSession {
  private sources = new Map<StreamingProvider, Source>();
  private controller = new AbortController();
  private initialResultsReleased = false;
  private started = false;
  private mergeTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  /** Services already searched for a leading song they didn't return, by service and song. */
  private completions = new Set<string>();
  private completing = 0;

  constructor(private options: Options) {
    for (const provider of [...new Set(options.providers)].sort()) {
      this.sources.set(provider, { tracks: new Map(), artists: [], albums: [], nextOffset: 0, pending: false, error: null });
    }
  }

  snapshot(): SearchSnapshot {
    const sources = [...this.sources.values()];
    const candidates = sources.flatMap(source => [...source.tracks.values()]);
    // Grouping preserves the native order of a single provider's recordings.
    const groups = this.options.combined ? rankSearchGroups(candidates, this.options.query) : groupSearchResults(candidates, "");
    const results = groups.map(group => group.track);
    const artistCandidates = sources.flatMap(source => source.artists);
    const albumCandidates = sources.flatMap(source => source.albums);
    const intent = categoryOrder(this.options.query, results, artistCandidates, albumCandidates, candidates)[0];
    const albums = rankAlbums(albumCandidates, this.options.query, intent === "albums" ? [] : results);
    const artists = rankArtists(artistCandidates, intent === "albums" && albums[0] ? albums[0].artist : this.options.query, intent === "albums" ? [] : results);
    const errors = [...this.sources].filter(([, source]) => source.error)
      .map(([provider]) => musicProviderName(provider));
    return {
      candidates,
      artists,
      albums,
      results,
      allResults: everyCopy(groups),
      isSearching: sources.some(source => source.pending),
      hasMore: sources.some(source => source.nextOffset !== null && !source.error),
      error: this.sources.size === 0 ? "No music services are connected." : errors.length ? `Some services could not be searched: ${errors.join(", ")}. Please try again.` : null,
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
    if (!next.isSearching) this.completeLeaders();
    // The first list waits for the leading songs' other copies too, within the same deadline,
    // so a song isn't shown from one service and then swapped for a better copy.
    if (!next.isSearching && this.completing === 0) {
      this.initialResultsReleased = true;
      clearTimeout(this.mergeTimer);
      clearTimeout(this.deadlineTimer);
    }
    // Every service answered and only the other copies are still being looked for: the deadline,
    // not the shorter merge window, bounds the wait.
    if (!next.isSearching && this.completing > 0) clearTimeout(this.mergeTimer);
    else if (!this.initialResultsReleased && (next.candidates.length > 0 || next.artists.length > 0 || next.albums.length > 0)) {
      const delay = this.options.initialMergeWindowMs ?? 1200;
      if (delay === 0) this.initialResultsReleased = true;
      else if (!this.mergeTimer) this.mergeTimer = setTimeout(this.releaseInitialResults, delay);
    }
    // The first visible list is consolidated when sources finish close together.
    // A slow/offline source can delay useful results by at most the bounded grace period.
    this.options.onUpdate(this.initialResultsReleased ? next : { ...next, results: [], allResults: [], candidates: [], artists: [], albums: [] });
  }

  /**
   * Looks on every service for the leading songs it didn't return. A service's search often
   * leaves out a song another one finds, or finds its release only as an album. Without its
   * copy the song would be shown from whichever service did return it, in that one's quality,
   * instead of the best copy (or the preferred service's) among everything connected.
   */
  private completeLeaders() {
    if (!this.options.combined || this.sources.size < 2) return;
    const sources = [...this.sources.values()];
    const candidates = sources.flatMap(source => [...source.tracks.values()]);
    const albums = sources.flatMap(source => source.albums);
    for (const group of rankSearchGroups(candidates, this.options.query).slice(0, COMPLETED_GROUPS)) {
      const song = `${searchText(group.track.artist)}|${searchText(group.track.name)}`;
      for (const [provider, source] of this.sources) {
        if (this.completions.size >= MAX_COMPLETIONS) return;
        const key = `${provider}|${song}`;
        if (source.error || this.completions.has(key) || group.alternatives.some(copy => copy.provider === provider)) continue;
        this.completions.add(key);
        this.completing++;
        void this.findCopies(provider, group, albums.filter(album => album.provider === provider && this.releases(album, group)))
          .then(copies => { for (const track of copies) source.tracks.set(track.globalId, track); })
          .catch(() => {})
          .finally(() => { this.completing--; this.publish(); });
      }
    }
  }

  /** The group's song on `provider`: from its release there, else from a search for just that song. */
  private async findCopies(provider: StreamingProvider, group: RecordingGroup, releases: CatalogAlbum[]) {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? 8000)]);
    const matching = (tracks: Track[]) => tracks.filter(track => track.provider === provider
      && group.alternatives.some(copy => sameRecording(copy, track)));
    const load = this.options.albumTracks;
    for (const album of load ? releases.slice(0, 1) : []) {
      const copies = matching(await load!(album, signal).catch(() => []));
      if (copies.length) return copies;
    }
    const song = group.track;
    const page = await this.options.fetchPage(`${song.artist} ${searchTrackTitle(song.name)}`, provider, signal, 0, 10);
    return matching(page.tracks);
  }

  /** An album that is the group's song's release: the song's album or single, by its artist. */
  private releases(album: CatalogAlbum, group: RecordingGroup) {
    const artist = searchText(album.artist);
    const titles = new Set(group.alternatives.flatMap(copy => [albumTitleFamily(copy.album), albumTitleFamily(copy.name)]).filter(Boolean));
    return titles.has(albumTitleFamily(album.title))
      && group.alternatives.some(copy => searchText(copy.artist) === artist || copy.albumArtists.some(credit => searchText(credit.name) === artist));
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
      this.deadlineTimer = setTimeout(this.releaseInitialResults, this.options.initialDeadlineMs ?? 1800);
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
