import type { GlobalTrackId } from "../types/music";
import type { DropPosition } from "./trackCollectionOrder";

/**
 * Packages bind consecutive songs in a playlist so they always play together, in order,
 * even when the playlist is shuffled (Airbag into Paranoid Android). Each package lists
 * its songs in playlist order; a playlist never repeats a song, so a song is in at most one.
 */
export type TrackPackages = GlobalTrackId[][];

export type PackageDrop = { trackId: GlobalTrackId; position: DropPosition };

/**
 * Keeps only songs still in the playlist, drops packages left with fewer than two, and
 * gathers each package's songs together where its first one sits, in playlist order.
 */
export function normalizePackages(
  trackIds: GlobalTrackId[],
  packages: TrackPackages = [],
): { trackIds: GlobalTrackId[]; packages: TrackPackages } {
  const present = new Set(trackIds);
  const claimed = new Set<GlobalTrackId>();
  const members = packages.map((pack) => {
    const owned = new Set(pack.filter((id) => present.has(id) && !claimed.has(id)));
    for (const id of owned) claimed.add(id);
    return owned;
  });
  const ordered = members
    .map((owned) => trackIds.filter((id) => owned.has(id)))
    .filter((pack) => pack.length >= 2);
  const owner = new Map(ordered.flatMap((pack, index) => pack.map((id) => [id, index] as const)));
  const placed = new Set<number>();
  const gathered: GlobalTrackId[] = [];
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

/** Binds the songs into one package, taking in whole any package one of them is already part of. */
export function bindPackage(trackIds: GlobalTrackId[], packages: TrackPackages, ids: GlobalTrackId[]) {
  const chosen = new Set(ids);
  const touched = packages.filter((pack) => pack.some((id) => chosen.has(id)));
  for (const pack of touched) for (const id of pack) chosen.add(id);
  return normalizePackages(trackIds, [
    ...packages.filter((pack) => !touched.includes(pack)),
    trackIds.filter((id) => chosen.has(id)),
  ]);
}

/** Dissolves every package one of the songs is part of. */
export function unbindPackages(trackIds: GlobalTrackId[], packages: TrackPackages, ids: GlobalTrackId[]) {
  const chosen = new Set(ids);
  return normalizePackages(trackIds, packages.filter((pack) => !pack.some((id) => chosen.has(id))));
}

/** Each song's package, so lookups while dragging and rendering stay cheap. */
export function packageIndex(packages: TrackPackages) {
  return new Map(packages.flatMap((pack) => pack.map((id) => [id, pack] as const)));
}

/** A sorted view still shows each package together, in its own order, where its first song sorts. */
export function groupPackagedTracks<T extends { globalId: GlobalTrackId }>(tracks: T[], packages: TrackPackages): T[] {
  if (!packages.length) return tracks;
  const byId = new Map(tracks.map((track) => [track.globalId, track]));
  const packed = packageIndex(packages);
  const placed = new Set<TrackPackages[number]>();
  return tracks.flatMap((track) => {
    const pack = packed.get(track.globalId);
    if (!pack) return [track];
    if (placed.has(pack)) return [];
    placed.add(pack);
    return pack.flatMap((id) => byId.get(id) ?? []);
  });
}

/**
 * Where a dragged song may land. A package's first song carries the whole package and
 * can't land inside another one, which it moves before or after instead; any other
 * packaged song only reorders within its own package. Null when it can't drop there.
 */
export function packageDrop(
  packages: TrackPackages,
  sourceId: GlobalTrackId,
  target: PackageDrop,
): PackageDrop | null {
  const packed = packageIndex(packages);
  const own = packed.get(sourceId);
  if (own && own[0] !== sourceId) return own.includes(target.trackId) ? target : null;
  if (own?.includes(target.trackId)) return null;
  const other = packed.get(target.trackId);
  if (!other) return target;
  // Into the nearer end of the other package, by where the pointer is along it.
  const along = other.indexOf(target.trackId) + (target.position === "after" ? 1 : 0);
  return along <= other.length / 2
    ? { trackId: other[0], position: "before" }
    : { trackId: other[other.length - 1], position: "after" };
}

/** Moves the dragged song, or its whole package when it leads one, to the drop. */
export function movePackaged(
  trackIds: GlobalTrackId[],
  packages: TrackPackages,
  sourceId: GlobalTrackId,
  target: PackageDrop,
): GlobalTrackId[] {
  const own = packageIndex(packages).get(sourceId);
  const moving = own && own[0] === sourceId ? own : [sourceId];
  if (moving.includes(target.trackId)) return trackIds;
  const rest = trackIds.filter((id) => !moving.includes(id));
  const index = rest.indexOf(target.trackId);
  if (index < 0) return trackIds;
  const at = index + (target.position === "after" ? 1 : 0);
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}
