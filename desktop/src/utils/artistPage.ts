import { loadArtistAlbums, loadArtistProfile, type CatalogAlbum, type CatalogArtist } from "../api/server";
import { rememberArtistImage } from "./artistImages";

export function prefetchArtistPage(artist: CatalogArtist) {
  if (artist.provider === "local") return;
  void loadArtistProfile(artist).then(profile => rememberArtistImage(profile.artist)).catch(() => {});
  void loadArtistAlbums(artist).catch(() => {});
}

export function artistReleaseSections(albums: CatalogAlbum[]) {
  const sections = ["Albums", "EPs & singles", "Live", "Other releases"].map(title => ({ title, albums: [] as CatalogAlbum[] }));
  for (const album of new Map(albums.map(album => [album.id, album])).values()) {
    const type = album.releaseType?.toLowerCase().replace(/[\s_-]/g, "") ?? "album";
    const index = ["ep", "single", "epsingle", "epsandsingles"].includes(type) ? 1 : type === "live" ? 2 : type === "album" ? 0 : 3;
    sections[index].albums.push(album);
  }
  for (const section of sections) section.albums.sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.title.localeCompare(b.title));
  return sections.filter(section => section.albums.length);
}
export function artistBiography(value: string | null | undefined): string[] {
  if (!value) return [];
  const paragraphs = value.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "").replace(/<\/?(?:p|div|br|li)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, "");
  const decoded = paragraphs.replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[entity] ?? entity);
  return decoded.split(/\n+/).map(paragraph => paragraph.trim()).filter(Boolean);
}
