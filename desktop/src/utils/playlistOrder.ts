import type { Playlist } from "../types/music";
import type { PlaylistGroup } from "./preferences";

/** Shared through the server so every device's sidebar lists playlists in the same order. */
export const PLAYLIST_ORDER_KEY = "ambra.playlist-order.v1";
export type PlaylistOrder = Record<PlaylistGroup, string[]>;

/** The server's order, falling back to this device's own for any group it doesn't have. */
export function sharedPlaylistOrder(raw: string | null, local: PlaylistOrder): PlaylistOrder {
  try {
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (!saved || typeof saved !== "object") return local;
    const order = { ...local };
    for (const group of Object.keys(local) as PlaylistGroup[]) {
      const ids = (saved as Record<string, unknown>)[group];
      if (Array.isArray(ids)) order[group] = ids.filter((id): id is string => typeof id === "string");
    }
    return order;
  } catch {
    return local;
  }
}

/** Playlists in the saved order; ones not in it yet keep their own order after those. */
export function orderPlaylists(playlists: Playlist[], order: string[]) {
  if (!order.length) return playlists;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...playlists].sort((left, right) => (rank.get(left.id) ?? order.length) - (rank.get(right.id) ?? order.length));
}
