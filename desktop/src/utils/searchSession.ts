import { albumBaseTitle, categoryOrder, rankArtists, rankAlbums, searchText, searchTrackTitle, type SearchCategory } from "./catalogRanking";
import type { CatalogArtist, CatalogAlbum, SearchPage, StreamingProvider } from "../api/server";
import type { Track } from "../types/music";
import { albumTitleFamily, asksForClean, everyCopy, explicitAudio, groupSearchResults, lossless, rankSearchGroups, sameSong, STRONG_MATCH, type RecordingGroup } from "./searchRanking";
import { artistCredits, matchTrack, queryVariants } from "./searchMatch";
import { musicProviderName } from "./musicProviderName";

export type SearchSnapshot = {
  results: Track[];
  /** Every copy found, services and editions included, grouped by recording. */
  allResults: Track[];
  artists: CatalogArtist[];
  albums: CatalogAlbum[];
  candidates: Track[];
  /** The sections in the order to show them, the one the query is after first. */
  order: SearchCategory[];
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
  /** Its first page is in: what it holds for the query is known, though it may still be asked more. */
  answered: boolean;
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
/** Songs and services looked up per search, at most. */
const MAX_COMPLETIONS = 10;
/** How many leading songs are also looked for by their album. */
const ALBUM_SEARCHED_GROUPS = 2;
/** Other phrasings of the query tried on a service that found nothing good, at most. */
const MAX_VARIANTS = 2;
/** How many songs a search shows before "Show all", and how much a shown song's place is held. */
const SHOWN = 5;
const HOLD = 0.05;
/** Services with no lossless audio: their answer can't replace a lossless copy already found. */
const LOSSY = new Set<StreamingProvider>(["spotify"]);

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
  /** The lookups among those on services with lossless audio: only they can change the copy shown. */
  private improving = 0;
  /** The songs on screen, first to fifth, by the copy shown. */
  private shown: string[] = [];
  /**
   * A shown song's hold on its place: a late answer must outrank it clearly to move it, so the
   * list doesn't reshuffle over evidence that barely separates two songs.
   */
  private held = (group: RecordingGroup) => {
    const place = this.shown.findIndex(id => group.alternatives.some(copy => copy.globalId === id));
    return place < 0 ? 0 : HOLD * (1 - place / SHOWN);
  };

  constructor(private options: Options) {
    for (const provider of [...new Set(options.providers)].sort()) {
      this.sources.set(provider, { tracks: new Map(), artists: [], albums: [], nextOffset: 0, pending: false, answered: false, error: null });
    }
  }

  snapshot(): SearchSnapshot {
    const sources = [...this.sources.values()];
    const candidates = sources.flatMap(source => [...source.tracks.values()]);
    const ranked = rankSearchGroups(candidates, this.options.query, this.held);
    // Grouping preserves the native order of a single provider's recordings.
    const groups = this.options.combined ? ranked : groupSearchResults(candidates, "");
    const results = groups.map(group => group.track);
    // The songs the query plainly names: their artists and albums belong in the results.
    const named = ranked.filter(group => group.relevance >= STRONG_MATCH).slice(0, 3).map(group => group.track);
    const artistCandidates = sources.flatMap(source => source.artists);
    const albumCandidates = sources.flatMap(source => source.albums);
    const order = categoryOrder(this.options.query, candidates, artistCandidates, albumCandidates);
    const intent = order[0];
    const albums = rankAlbums(albumCandidates, this.options.query, intent === "albums" ? [] : named, intent === "tracks");
    const artists = rankArtists(artistCandidates, intent === "albums" && albums[0] ? albums[0].artist : this.options.query, intent === "albums" ? [] : named, intent === "tracks");
    const errors = [...this.sources].filter(([, source]) => source.error)
      .map(([provider]) => musicProviderName(provider));
    return {
      candidates,
      artists,
      albums,
      results,
      order,
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

  /**
   * Whether the first list can be shown before every service answers: the leading song is one
   * the query plainly names, in lossless, and only services without lossless audio are still
   * out or being asked for it. Their answer can add copies and songs below; it can't change
   * which copy leads.
   */
  private settled(next: SearchSnapshot) {
    if (!this.options.combined || this.improving > 0) return false;
    const waiting = [...this.sources].filter(([, source]) => source.pending);
    if (!waiting.every(([provider, source]) => source.answered ? false : LOSSY.has(provider))) return false;
    const leader = next.results[0];
    return !!leader && lossless(leader) && matchTrack(leader, this.options.query).score >= STRONG_MATCH;
  }

  private publish() {
    if (this.controller.signal.aborted) return;
    // Started as each service answers, not after the slowest one: the services that have
    // answered are asked for the leading songs they left out while the others are still out.
    this.completeLeaders();
    const next = this.snapshot();
    if (!this.initialResultsReleased && this.settled(next)) {
      this.initialResultsReleased = true;
      clearTimeout(this.mergeTimer);
      clearTimeout(this.deadlineTimer);
    }
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
    if (this.initialResultsReleased) this.shown = next.results.slice(0, SHOWN).map(track => track.globalId);
    this.options.onUpdate(this.initialResultsReleased ? next : { ...next, results: [], allResults: [], candidates: [], artists: [], albums: [] });
  }

  /**
   * Asks a service again, another way, when it found no song the query plainly names: its
   * search may stumble on a dash, a bracket or pasted words that ours reads through.
   */
  private async widen(provider: StreamingProvider, source: Source, signal: AbortSignal) {
    const named = () => [...source.tracks.values()].some(track => matchTrack(track, this.options.query).score >= STRONG_MATCH);
    for (const variant of queryVariants(this.options.query).slice(0, MAX_VARIANTS)) {
      if (named() || signal.aborted) return;
      const page = await this.options.fetchPage(variant, provider, signal, 0, 20).catch(() => null);
      if (!page || signal.aborted) continue;
      // After the service's own answer, so its order still says what it found most likely.
      for (const track of page.tracks) if (!source.tracks.has(track.globalId)) source.tracks.set(track.globalId, track);
      source.artists.push(...page.artists ?? []);
      source.albums.push(...page.albums ?? []);
    }
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
    // Only songs the query plainly names: a loose match isn't worth asking every service about.
    const strong = rankSearchGroups(candidates, this.options.query).slice(0, COMPLETED_GROUPS).filter(group => group.relevance >= STRONG_MATCH);
    // The first song, and the others by its artist. Other artists' songs of the same name (covers,
    // namesakes) are looked for nowhere else: in the search benchmark, completing them never
    // changed the copy that leads, and their late answers reordered the list.
    const credits = (group: RecordingGroup) => artistCredits(group.alternatives.flatMap(copy => [copy.artist, ...copy.artists.map(artist => artist.name)]));
    const lead = strong[0] ? credits(strong[0]) : new Set<string>();
    const leaders = strong.filter((group, index) => index === 0 || [...credits(group)].some(name => lead.has(name)));
    for (const [index, group] of leaders.entries()) {
      const song = `${searchText(group.track.artist)}|${searchText(group.track.name)}`;
      const explicit = explicitAudio(group.alternatives);
      // The explicit edit is the one meant. A service showing only its clean edit holds the
      // explicit one too, so it is looked for there rather than settled for from another service.
      const explicitWanted = !asksForClean(this.options.query) && group.alternatives.some(explicit);
      for (const [provider, source] of this.sources) {
        if (this.completions.size >= MAX_COMPLETIONS) return;
        const held = group.alternatives.filter(copy => copy.provider === provider);
        const onlyClean = explicitWanted && held.length > 0 && !held.some(explicit);
        const key = `${provider}|${song}${onlyClean ? "|explicit" : ""}`;
        // A service still out may yet return the song itself.
        if (!source.answered || source.error || this.completions.has(key) || (held.length > 0 && !onlyClean)) continue;
        this.completions.add(key);
        this.completing++;
        const improves = !LOSSY.has(provider);
        if (improves) this.improving++;
        const tried = new Set(held.map(copy => copy.albumId?.split(":").pop()));
        const releases = albums.filter(album => album.provider === provider && this.releases(album, group)
          && !(onlyClean && tried.has(album.id.split(":").pop())))
          // An album marked explicit first: it is where the explicit edit is.
          .sort((a, b) => Number(b.explicit ?? false) - Number(a.explicit ?? false));
        void this.findCopies(provider, group, releases, index < ALBUM_SEARCHED_GROUPS, onlyClean)
          .then(({ copies, album }) => {
            for (const track of copies) source.tracks.set(track.globalId, track);
            // Its album was found here too: the album's card can now open this service's copy.
            if (album) source.albums.push(album);
          })
          .catch(() => {})
          .finally(() => { this.completing--; if (improves) this.improving--; this.publish(); });
      }
    }
  }

  /**
   * The group's song on `provider`: from its release there when the search already found it,
   * else from a search for just that song. With `searchAlbums`, its album is then searched
   * for too: a service can hold a song it will not return by name, on an album it will.
   */
  private async findCopies(provider: StreamingProvider, group: RecordingGroup, releases: CatalogAlbum[], searchAlbums: boolean, explicitOnly = false): Promise<{ copies: Track[]; album?: CatalogAlbum }> {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? 8000)]);
    // `explicitOnly`: the service's clean edit is already known; only its explicit one is news.
    const matching = (tracks: Track[]) => tracks.filter(track => track.provider === provider
      && (!explicitOnly || track.explicit) && group.alternatives.some(copy => sameSong(copy, track)));
    const load = this.options.albumTracks;
    const onAlbum = async (albums: CatalogAlbum[]): Promise<{ copies: Track[]; album?: CatalogAlbum }> => {
      // An explicit edit sits on another edition of the album, so more than the first is opened.
      for (const album of load ? albums.slice(0, explicitOnly ? 3 : 1) : []) {
        const copies = matching(await load!(album, signal).catch(() => []));
        if (copies.length) return { copies, album };
      }
      return { copies: [] };
    };
    const released = (page: SearchPage | null) => (page?.albums ?? []).filter(album => album.provider === provider && this.releases(album, group))
      .sort((a, b) => Number(b.explicit ?? false) - Number(a.explicit ?? false));
    const known = await onAlbum(releases);
    if (known.copies.length) return { copies: known.copies };
    const song = group.track;
    const search = (text: string) => this.options.fetchPage(text, provider, signal, 0, 10).catch(() => null);
    // The album the song is on, rather than a single named after it, which the song search covers.
    const album = load && searchAlbums ? group.alternatives.find(copy => albumTitleFamily(copy.album) !== albumTitleFamily(copy.name)) : undefined;
    const credit = album ? album.albumArtists[0]?.name ?? album.artist : "";
    // Both searches leave together: the album's answer is ready by the time the song's has failed.
    const songSearch = search(`${song.artist} ${searchTrackTitle(song.name)}`);
    const albumSearch = album ? search(/^various( artists)?$/i.test(credit.trim()) ? albumBaseTitle(album.album) : `${albumBaseTitle(album.album)} ${credit}`) : null;
    const page = await songSearch;
    const copies = matching(page?.tracks ?? []);
    if (copies.length || !load || !searchAlbums) return { copies };
    const single = await onAlbum(released(page));
    if (single.copies.length) return single;
    if (!albumSearch) return { copies: [] };
    const found = await albumSearch;
    const listed = matching(found?.tracks ?? []);
    return listed.length ? { copies: listed } : onAlbum(released(found));
  }

  /** An album that is the group's song's release: the song's album or single, by its artist. */
  private releases(album: CatalogAlbum, group: RecordingGroup) {
    const titles = new Set(group.alternatives.flatMap(copy => [albumTitleFamily(copy.album), albumTitleFamily(copy.name)]).filter(Boolean));
    if (!titles.has(albumTitleFamily(album.title))) return false;
    const names = artistCredits(album.artists?.length ? album.artists.map(artist => artist.name) : [album.artist]);
    // A compilation is credited to its artists on one service and to "Various Artists" on another.
    const various = (credits: Set<string>) => credits.has("various artists") || credits.has("various");
    return various(names) || group.alternatives.some(copy => {
      const credits = artistCredits([copy.artist, ...copy.artists.map(artist => artist.name), ...copy.albumArtists.map(artist => artist.name)]);
      return various(credits) || [...credits].some(name => names.has(name));
    });
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
        if (!source.answered) {
          source.answered = true;
          // Shown or completed from now, not after the other phrasings below have been tried.
          this.publish();
        }
        // Another phrasing is a bonus: running out of time on it must not fail the answer already in hand.
        if (offset === 0) await Promise.race([this.widen(provider, source, controller.signal), aborted]).catch(() => {});
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
