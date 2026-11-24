import type { Playlist } from "../types/music";

/** Playlists in the saved order; ones not in it yet keep their own order after those. */
export function orderPlaylists(playlists: Playlist[], order: string[]) {
  if (!order.length) return playlists;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...playlists].sort((left, right) => (rank.get(left.id) ?? order.length) - (rank.get(right.id) ?? order.length));
}
