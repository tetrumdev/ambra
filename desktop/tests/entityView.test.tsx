import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityView, type EntityViewProps } from "../src/components/EntityView";
import { ArtworkImage } from "../src/components/ArtworkImage";
import { ArtistPortrait } from "../src/components/ArtistPortrait";
import { thumbnailSource } from "../src/api/server";
import { preloadArtwork } from "../src/utils/artworkImages";
import { rememberArtistImage } from "../src/utils/artistImages";
import { albumForTrack, type BrowseEntity } from "../src/utils/browse";
import { track } from "./searchFixture";

const song = track("qobuz:album-scope", "qobuz", { albumId: "scope-album" });
function render(entity: BrowseEntity, libraryTracks = [] as typeof song[], cache: EntityViewProps["cache"] = new Map()) {
  return renderToStaticMarkup(<EntityView entity={entity} cache={cache} libraryTracks={libraryTracks}
    onBack={() => {}} onOpenEntity={() => {}} onAction={() => {}} onAddTrack={() => {}}
    rememberTracks={() => {}} registerScrollElement={() => {}} playlistOptions={{ playlists: [], onCreate: () => true, onAdd: () => true }} />);
}

test("album defaults to the entire tracklist unless this edition has a saved song", () => {
  const entity: BrowseEntity = { kind: "album", album: albumForTrack(song) };
  expect(render(entity)).toContain('aria-current="page">Entire tracklist');
  expect(render(entity, [song])).toContain('aria-current="page">Saved songs');
  expect(render(entity, [{ ...song, albumId: "another-edition" }])).toContain('aria-current="page">Entire tracklist');
  expect(render(entity, [], new Map([["album:qobuz:scope-album", { entire: false }]]))).toContain('aria-current="page">Saved songs');
});

test("artist sections occupy their space before network data arrives", () => {
  const html = render({ kind: "artist", artist: { id: "qobuz:initial-sections", provider: "qobuz", name: "Artist", imageUrl: null } });
  expect(html).toContain('>Popular</h2>');
  expect(html).toContain('>Albums</h2>');
  expect(html).toContain('aria-label="Loading popular tracks"');
  expect(html).toContain('aria-label="Loading releases"');
  expect(html).not.toContain('class="albumArtworkTrigger"');
});

test("only album view exposes the cover enlargement dialog", () => {
  const html = render({ kind: "album", album: albumForTrack(song) }, [song]);
  expect(html).toContain('class="albumArtworkTrigger"');
  expect(html).toContain('class="albumArtworkDialog"');
});

test("album track rows have play buttons and track numbers without repeating album artwork", () => {
  const html = render({ kind: "album", album: albumForTrack(song) }, [song]);
  expect(html).toContain('class="trackPlayButton"');
  expect(html).toContain('aria-label="Play Deadman"');
  expect(html).toContain('class="trackNumber">7</small>');
  expect(html).not.toContain('class="coverImgContainer"');
  expect(html).toContain('class="albumArtworkTrigger"');
});

test("remounted artwork and portraits immediately display decoded canonical thumbnails", async () => {
  const originalImage = globalThis.Image;
  globalThis.Image = class { src = ""; decoding = ""; async decode() {} } as unknown as typeof Image;
  try {
    const source = "https://static.qobuz.com/images/remount_600.jpg";
    await preloadArtwork(thumbnailSource(source));
    expect(renderToStaticMarkup(<ArtworkImage src={source} />)).toContain("/api/artwork/thumbnail?");
    const artist = { id: "qobuz:canonical-render", provider: "qobuz" as const, name: "Artist", imageUrl: "library-old.jpg" };
    rememberArtistImage({ ...artist, imageUrl: source });
    const html = renderToStaticMarkup(<ArtistPortrait artist={artist} />);
    expect(html).toContain("/api/artwork/thumbnail?");
    expect(html).not.toContain("library-old.jpg");
  } finally { globalThis.Image = originalImage; }
});
