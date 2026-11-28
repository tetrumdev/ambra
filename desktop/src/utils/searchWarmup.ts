import type { Track } from "../types/music";
import { groupSearchResults } from "./searchRanking";
import type { SearchSnapshot } from "./searchSession";

/**
 * Resolves the TIDAL copies shown among the leading songs, for their exact quality and a quick
 * start, and the first song's hidden TIDAL copies, one of which may sound better than the copy
 * shown. Other songs' hidden copies aren't: in the search benchmark, warming them never changed
 * which copy leads and cost about three upstream requests per search. At most five, two at a time,
 * once every service has answered. Feed it each snapshot; `replace` gets each resolved copy.
 */
export function leaderWarmup(query: string, signal: AbortSignal, resolve: (track: Track, signal: AbortSignal) => Promise<Track>, replace: (track: Track) => void) {
  const warmed = new Set<string>();
  const queue: Track[] = [];
  let active = 0;
  const drain = () => {
    while (active < 2 && queue.length && !signal.aborted) {
      const track = queue.shift()!;
      active++;
      void resolve(track, signal).then(resolved => {
        if (!signal.aborted) replace(resolved);
      }).catch(() => {}).finally(() => { active--; drain(); });
    }
  };
  return (next: SearchSnapshot) => {
    if (signal.aborted || next.isSearching || warmed.size >= 5) return;
    const leader = next.results[0] && groupSearchResults(next.candidates, query).find(group => group.track.globalId === next.results[0].globalId);
    for (const track of [...next.results.slice(0, 5), ...leader?.alternatives ?? []]) {
      if (warmed.size >= 5) break;
      if (track.provider !== "tidal" || warmed.has(track.globalId)) continue;
      warmed.add(track.globalId);
      queue.push(track);
    }
    drain();
  };
}
