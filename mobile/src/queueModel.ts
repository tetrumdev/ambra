import type { MobilePlaylist, QueueItem, QueueSnapshot, Track } from "./client";

/**
 * desktop/src/utils/playlistPackages.ts `normalizePackages`: keeps only songs still in the playlist,
 * drops packages left with fewer than two, and gathers each package where its first song sits.
 */
export function normalizePackages(trackIds: string[], packages: string[][] = []): { trackIds: string[]; packages: string[][] } {
  const present = new Set(trackIds);
  const claimed = new Set<string>();
  const members = packages.map(pack => {
    const owned = new Set(pack.filter(id => present.has(id) && !claimed.has(id)));
    for (const id of owned) claimed.add(id);
    return owned;
  });
  const ordered = members.map(owned => trackIds.filter(id => owned.has(id))).filter(pack => pack.length >= 2);
  const owner = new Map(ordered.flatMap((pack, index) => pack.map(id => [id, index] as const)));
  const placed = new Set<number>();
  const gathered: string[] = [];
  for (const id of trackIds) {
    const index = owner.get(id);
    if (index === undefined) gathered.push(id);
    else if (!placed.has(index)) {
      placed.add(index);
      gathered.push(...ordered[index]);
    }
  }
  return { trackIds: gathered, packages: ordered };
}

export function playlistEntries(playlist: MobilePlaylist, tracks: Track[]): QueueItem[] {
  const packages = new Map(playlist.packages?.flatMap(pack => pack.map(id => [id, `${playlist.id}:${pack[0]}`] as const)));
  return tracks.map((track, index) => ({
    globalTrackId: track.globalId,
    source: { kind: "playlist", id: playlist.id, entryId: index + 1 },
    shufflePackageId: packages.get(track.globalId) ?? null,
  }));
}

/** Bound songs remain together, in playlist order, just as on desktop. */
export function shuffledEntries(entries: QueueItem[], random = Math.random): QueueItem[] {
  const units: QueueItem[][] = [];
  const packages = new Map<string, QueueItem[]>();
  for (const entry of entries) {
    const id = entry.shufflePackageId;
    const group = id ? packages.get(id) : undefined;
    if (group) group.push(entry);
    else {
      const unit = [entry];
      units.push(unit);
      if (id) packages.set(id, unit);
    }
  }
  for (let index = units.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [units[index], units[swap]] = [units[swap], units[index]];
  }
  return units.flat();
}

function archive(queue: QueueSnapshot) {
  return [...(queue.history ?? []), ...(queue.current ? [{
    ...queue.current,
    historyId: `phone-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    playedAt: new Date().toISOString(),
  }] : [])].slice(-100);
}

export function queueTracks(queue: QueueSnapshot, tracks: Track[]): Track[] {
  return [...new Map([...(queue.tracks ?? []), ...tracks].map(track => [track.globalId, track])).values()];
}

export function playEntries(queue: QueueSnapshot, entries: QueueItem[], tracks: Track[]): QueueSnapshot {
  if (!entries.length) return queue;
  return { version: 1, history: archive(queue), current: entries[0], upcoming: entries.slice(1), tracks: queueTracks(queue, tracks) };
}

export function enqueueEntries(queue: QueueSnapshot, entries: QueueItem[], tracks: Track[], next = false): QueueSnapshot {
  if (!entries.length) return queue;
  if (!queue.current) return playEntries(queue, entries, tracks);
  return { ...queue, version: 1, history: queue.history ?? [], upcoming: next ? [...entries, ...queue.upcoming] : [...queue.upcoming, ...entries], tracks: queueTracks(queue, tracks) };
}

/** Positions are only safe against the revision the person actually saw (duplicates are valid). */
export function editUpcoming(queue: QueueSnapshot, revision: number, expected: number, index: number, action: "play" | "remove"): QueueSnapshot {
  if (revision !== expected) throw new Error("The queue changed on another device. Please try again.");
  const entry = queue.upcoming[index];
  if (!entry) throw new Error("This song is no longer in the queue.");
  if (action === "remove") return { ...queue, upcoming: queue.upcoming.filter((_, at) => at !== index) };
  return { ...queue, history: archive(queue), current: entry, upcoming: queue.upcoming.slice(index + 1) };
}
