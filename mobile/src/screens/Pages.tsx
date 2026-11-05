import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { CatalogAlbum, CatalogArtist } from "../../../desktop/src/api/server";
import type { Track } from "../../../desktop/src/types/music";
import { musicProviderName } from "../../../desktop/src/utils/musicProviderName";
import { sortAlbumTracks, tracksForEntity } from "../../../desktop/src/utils/browse";
import { changeQueue, offlineActive, thumbnailArtwork } from "../client";
import { phoneTrack, removePhoneDownloads, useDownloads } from "../downloads";
import { Icon } from "../Icons";
import {
  albumTracks, artistAlbums, artistProfile, createPlaylist, deletePlaylist, deleteServicePlaylist, discover, duplicatePlaylist,
  libraryAlbums, libraryArtists, playlistSongs, refreshLibrary, removeFromLibrary, removeFromPlaylist, removeFromServicePlaylist,
  renamePlaylist, renameServicePlaylist, reorderLibrary, reorderPlaylist, servicePlaylistContents, useLibrary, type ArtistProfile, type Discover, type ServicePlaylistContents,
} from "../library";
import type { MenuAction } from "../Menu";
import { ScreenHeader, reason, showToast, useNavigation, useRun, type Route } from "../navigation";
import { playEntries } from "../queueModel";
import { services, type Service } from "../servicePreferences";
import { PromptSheet, openDownloadSheet } from "../Sheets";
import { colors, fonts } from "../theme";
import { Touchable } from "../Touchable";
import { CardGrid, CardRow, type Card } from "./Cards";
import { CollectionArt, TrackListScreen } from "./TrackListScreen";
import { exportPlaylist, importMusic, improvePlaylist } from "../playlistTools";

const albumCard = (album: CatalogAlbum, push: (route: Route) => void): Card => ({
  key: album.id, title: album.title, subtitle: [album.artist, album.releaseDate?.slice(0, 4)].filter(Boolean).join(" · "), image: album.imageUrl,
  onPress: () => push({ kind: "album", album }),
});
const artistCard = (artist: CatalogArtist & { trackCount?: number }, push: (route: Route) => void): Card => ({
  key: artist.id, title: artist.name, subtitle: artist.trackCount ? `${artist.trackCount} ${artist.trackCount === 1 ? "track" : "tracks"}` : undefined,
  image: artist.imageUrl, round: true, onPress: () => push({ kind: "artist", artist }),
});

type Prompt = { title: string; message?: string; initial?: string; confirmLabel: string; destructive?: boolean; onSubmit(value: string): Promise<unknown> };

/** An AMBRA or service playlist, with desktop's playlist menu (PlaylistActions). */
export function PlaylistScreen({ id, provider, name }: { id: string; provider?: Service; name: string }) {
  const library = useLibrary();
  const { back } = useNavigation();
  const [contents, setContents] = useState<ServicePlaylistContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [improving, setImproving] = useState<{ done: number; total: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const improvement = useRef<AbortController | null>(null);
  useEffect(() => () => improvement.current?.abort(), []);
  useEffect(() => {
    if (!provider) return;
    const abort = new AbortController();
    void servicePlaylistContents(provider, id, abort.signal).then(value => { setContents(value); setError(null); })
      .catch(failure => { if (!abort.signal.aborted) setError(reason(failure, "Couldn't load this playlist.")); });
    return () => abort.abort();
  }, [provider, id, reload]);
  const ambra = provider ? undefined : library.playlists.find(playlist => playlist.id === id);
  const tracks = useMemo(() => ambra ? playlistSongs(ambra, library) : contents?.tracks ?? [], [ambra, library, contents]);
  const title = ambra?.name ?? contents?.playlist.name ?? name;
  const editable = !provider || !!contents?.playlist.editable;
  const later = (work: () => void) => setTimeout(work, 220);
  const actions: MenuAction[] = offlineActive() ? [] : [
    ...(editable ? [{ label: "Rename Playlist", icon: "edit" as const, run: () => later(() => setPrompt({ title: "Rename playlist", initial: title, confirmLabel: "Save",
      onSubmit: value => provider ? renameServicePlaylist(provider, id, value).then(() => setReload(value => value + 1)) : renamePlaylist(id, value) })) }] : []),
    { label: "Duplicate Playlist", icon: "duplicate", run: () => void duplicatePlaylist(title, tracks).then(() => showToast("Playlist duplicated")).catch(failure => showToast(reason(failure, "Couldn't duplicate this playlist."), true)) },
    { label: "Download Playlist", icon: "download", disabled: !tracks.length, run: () => later(() => openDownloadSheet(tracks, title)) },
    ...(ambra ? [{ label: improving ? "Improving…" : "Improve Playlist", icon: "sparkle" as const, disabled: !!improving || !tracks.length, run: () => {
      const controller = new AbortController();
      improvement.current = controller;
      setStatus(null);
      setImproving({ done: 0, total: tracks.length });
      void improvePlaylist(ambra, (done, total) => setImproving({ done, total }), controller.signal)
        .then(upgraded => setStatus(upgraded ? `Moved ${upgraded} song${upgraded === 1 ? "" : "s"} to ${upgraded === 1 ? "a better copy" : "better copies"}.` : "Every song is already on the best copy available."))
        .catch(failure => { if (!controller.signal.aborted) setStatus(reason(failure, "Could not reach your music services. Please try again.")); })
        .finally(() => setImproving(null));
    } }] : []),
    { label: "Export Playlist", icon: "duplicate", disabled: !tracks.length, run: () => later(() => void exportPlaylist(title, tracks).catch(failure => showToast(reason(failure, "Couldn't export this playlist."), true))) },
    ...(editable ? [{ label: "Delete Playlist", icon: "remove" as const, destructive: true, run: () => later(() => setPrompt({ title: "Delete playlist?", message: `Delete “${title}”?`, confirmLabel: "Delete", destructive: true,
      onSubmit: () => (provider ? deleteServicePlaylist(provider, id) : deletePlaylist(id)).then(back) })) }] : []),
  ];
  const remove = !editable ? undefined : {
    label: "Remove from Playlist",
    run: (track: Track) => provider && contents
      ? removeFromServicePlaylist(provider, id, contents.entries.filter(entry => entry.trackId === track.globalId || entry.trackId === track.providerTrackId).map(entry => entry.id), contents.revision).then(() => setReload(value => value + 1))
      : removeFromPlaylist(id, [track.globalId]),
  };
  return <>
    <TrackListScreen
      title={title}
      subtitle={provider ? musicProviderName(provider) : "AMBRA playlist"}
      art={<CollectionArt tracks={tracks} />}
      tracks={tracks}
      source={{ kind: "playlist", id }}
      packages={ambra?.packages}
      loading={provider ? !contents && !error : library.loading && !ambra}
      error={error ?? (!provider && !ambra && !library.loading ? "This playlist was deleted." : null)}
      onRefresh={() => provider ? setReload(value => value + 1) : refreshLibrary()}
      remove={remove}
      collectionActions={actions}
      onReorder={ambra && !offlineActive() ? ids => reorderPlaylist(id, ids) : undefined}
      empty="No songs in this playlist yet."
      header={improving || status ? <Text accessibilityRole="alert" style={styles.status}>{improving ? `Checking ${improving.done} of ${improving.total} songs…` : status}</Text> : undefined}
    />
    {prompt && <PromptSheet {...prompt} onClose={() => setPrompt(null)} />}
  </>;
}

/** An album's songs from its service, or from the library for albums no catalog knows. */
export function AlbumScreen({ album }: { album: CatalogAlbum }) {
  const library = useLibrary();
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const fromLibrary = () => tracksForEntity({ kind: "album", album }, library.tracks);
    void albumTracks(album, abort.signal).then(value => setTracks(sortAlbumTracks(value))).catch(failure => {
      if (abort.signal.aborted) return;
      const known = fromLibrary();
      if (known.length) setTracks(known); else setError(reason(failure, "Couldn't load this album."));
    });
    return () => abort.abort();
    // The library only fills in when the catalog can't answer; it isn't a reason to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [album]);
  const shown = tracks ?? [];
  return <TrackListScreen
    title={album.title}
    subtitle={[album.artist, album.releaseDate?.slice(0, 4)].filter(Boolean).join(" · ")}
    art={<CollectionArt image={album.imageUrl ?? (shown[0] ? thumbnailArtwork(shown[0]) : null)} size={200} />}
    tracks={shown}
    source={{ kind: "search", id: `album:${album.id}` }}
    loading={!tracks && !error}
    error={error}
    collectionActions={offlineActive() ? [] : [{ label: "Download Album", icon: "download", disabled: !shown.length, run: () => setTimeout(() => openDownloadSheet(shown, album.title), 220) }]}
  />;
}

/** An artist's popular songs, then their albums, as desktop's artist page. */
export function ArtistScreen({ artist }: { artist: CatalogArtist }) {
  const { push } = useNavigation();
  const [profile, setProfile] = useState<ArtistProfile | null>(null);
  const [albums, setAlbums] = useState<CatalogAlbum[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void artistProfile(artist, abort.signal).then(setProfile).catch(failure => { if (!abort.signal.aborted) setError(reason(failure, "Couldn't load this artist.")); });
    void artistAlbums(artist, 0, abort.signal).then(page => setAlbums(page.albums)).catch(() => {});
    return () => abort.abort();
  }, [artist]);
  const shown = profile?.artist ?? artist;
  const popular = profile?.popularTracks ?? [];
  return <TrackListScreen
    title={shown.name}
    subtitle={musicProviderName(shown.provider === "local" ? "tidal" : shown.provider)}
    art={<CollectionArt image={shown.imageUrl} round size={168} />}
    tracks={popular}
    source={{ kind: "search", id: `artist:${artist.id}` }}
    loading={!profile && !error}
    error={error ?? profile?.popularTracksError}
    empty="No popular songs found."
    header={<>
      {albums.length > 0 && <CardRow title="Albums" cards={albums.map(album => albumCard(album, push))} />}
      {profile?.biography && <Text style={styles.biography} numberOfLines={8}>{profile.biography}</Text>}
      {popular.length > 0 && <Text style={styles.listHeading}>Popular</Text>}
    </>}
  />;
}

/** Library › Tracks, Artists or Albums. */
export function SectionScreen({ section }: { section: "artists" | "albums" | "tracks" }) {
  const library = useLibrary();
  const { push, bottomInset } = useNavigation();
  if (section === "tracks") {
    return <TrackListScreen
      title="Tracks"
      art={<CollectionArt tracks={library.tracks} />}
      tracks={library.tracks}
      source={{ kind: "library", id: "library" }}
      loading={library.loading}
      error={library.error}
      onRefresh={refreshLibrary}
      remove={{ label: "Remove from Library", run: track => removeFromLibrary([track]) }}
      onReorder={offlineActive() ? undefined : reorderLibrary}
      collectionActions={offlineActive() ? [] : [{ label: "Download Library", icon: "download", disabled: !library.tracks.length, run: () => setTimeout(() => openDownloadSheet(library.tracks, "your library"), 220) }]}
      empty="Add songs from Search to build your library."
    />;
  }
  const cards = section === "artists"
    ? libraryArtists(library.tracks).map(artist => artistCard(artist, push))
    : libraryAlbums(library.tracks).map(album => albumCard(album, push));
  return <CardGrid cards={cards} bottomInset={bottomInset} header={<ScreenHeader title={section === "artists" ? "Artists" : "Albums"} subtitle={`${cards.length} ${section}`} />} />;
}

/** Songs saved on this phone, which play with or without a server. */
export function DownloadsScreen() {
  const { phone, active } = useDownloads();
  const tracks = useMemo(() => [...phone.values()].map(phoneTrack), [phone]);
  const size = [...phone.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return <TrackListScreen
    title="Downloads"
    subtitle={`On this phone · ${(size / 1024 ** 3).toFixed(size > 1024 ** 3 ? 1 : 2)} GB${active ? ` · downloading ${active.done + 1} of ${active.total}` : ""}`}
    art={<CollectionArt tracks={tracks} />}
    tracks={tracks}
    source={{ kind: "library", id: "downloads" }}
    remove={{ label: "Remove Download", run: track => removePhoneDownloads([track.globalId]) }}
    collectionActions={[{ label: "Remove All Downloads", icon: "remove", destructive: true, disabled: !tracks.length, run: () => void removePhoneDownloads([...phone.keys()]).then(() => showToast("Downloads removed")) }]}
    empty="Download songs to this phone from any song, playlist or library menu. They play even without a server."
  />;
}

function Row({ title, detail, icon, onPress }: { title: string; detail?: string; icon?: "download" | "playlistAdd" | "album" | "add"; onPress(): void }) {
  return (
    <Touchable accessibilityRole="button" highlight haptic="select" onPress={onPress} style={styles.row}>
      {icon && <Icon name={icon} size={18} color={colors.secondary} />}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
        {detail && <Text style={styles.rowDetail} numberOfLines={1}>{detail}</Text>}
      </View>
      <Icon name="back" rotation={180} size={12} color={colors.faint} />
    </Touchable>
  );
}

/** Desktop's library overview and sidebar playlists, together on one page. */
export function LibraryScreen() {
  const library = useLibrary();
  const { phone } = useDownloads();
  const { push, bottomInset } = useNavigation();
  const [prompt, setPrompt] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  const offline = offlineActive();
  const artists = useMemo(() => libraryArtists(library.tracks).length, [library.tracks]);
  const albums = useMemo(() => libraryAlbums(library.tracks).length, [library.tracks]);
  return <>
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void refreshLibrary().finally(() => setRefreshing(false)); }} tintColor="white" />}>
      <ScreenHeader title="My Library" subtitle={offline ? "Offline · showing songs on this phone" : undefined} />
      {offline ? null : <>
        <View style={styles.overview}>
          {([["tracks", "Tracks", library.tracks.length], ["artists", "Artists", artists], ["albums", "Albums", albums]] as const).map(([section, label, count]) => (
            <Touchable key={section} accessibilityRole="button" accessibilityLabel={`${label}, ${count}`} scale={0.97} haptic="select" onPress={() => push({ kind: "section", section })} style={styles.overviewCard}>
              <Text style={styles.overviewTitle}>{label}</Text>
              <Text style={styles.overviewCount}>{count}</Text>
            </Touchable>
          ))}
        </View>
        {library.error && <Text accessibilityRole="alert" style={styles.error}>{library.error}</Text>}
      </>}
      <Row title="Downloads" detail={`${phone.size} ${phone.size === 1 ? "song" : "songs"} on this phone`} icon="download" onPress={() => push({ kind: "downloads" })} />
      {!offline && <Row title={importing ? `Importing ${importing.done} of ${importing.total}…` : "Import Music"} detail="Add music files from this phone to your library" icon="add" onPress={() => {
        if (importing) return;
        void importMusic((done, total) => setImporting({ done, total })).then(({ imported, failed }) => {
          if (failed.length) showToast(`${imported} imported, ${failed.length} failed: ${failed[0]}`, true);
          else if (imported) showToast(`Imported ${imported} song${imported === 1 ? "" : "s"}`);
        }).catch(failure => showToast(reason(failure, "Couldn't import music."), true)).finally(() => setImporting(null));
      }} />}
      {!offline && <>
        <View style={styles.groupHeader}>
          <Text style={styles.group}>AMBRA ({library.playlists.length})</Text>
          <Touchable accessibilityRole="button" accessibilityLabel="New playlist" haptic="tap" onPress={() => setPrompt(true)} style={styles.newButton}><Icon name="add" size={16} /></Touchable>
        </View>
        {library.loading && !library.loadedAt && <ActivityIndicator color={colors.muted} style={styles.loading} />}
        {library.playlists.map(playlist => <Row key={playlist.id} title={playlist.name} detail={`${playlist.trackIds.length} ${playlist.trackIds.length === 1 ? "song" : "songs"}`} onPress={() => push({ kind: "playlist", id: playlist.id, name: playlist.name })} />)}
        {services.map(service => library.servicePlaylists[service].length > 0 && <View key={service}>
          <Text style={styles.group}>{musicProviderName(service)} ({library.servicePlaylists[service].length})</Text>
          {library.servicePlaylists[service].map(playlist => <Row key={playlist.id} title={playlist.name} detail={`${playlist.trackCount} ${playlist.trackCount === 1 ? "song" : "songs"}`} onPress={() => push({ kind: "playlist", id: playlist.id, provider: service, name: playlist.name })} />)}
        </View>)}
      </>}
    </ScrollView>
    {prompt && <PromptSheet title="New playlist" initial="" confirmLabel="Create" onSubmit={value => createPlaylist(value)} onClose={() => setPrompt(false)} />}
  </>;
}

/** Desktop's home: what you played, what to discover, your playlists. */
export function HomeScreen() {
  const library = useLibrary();
  const { phone } = useDownloads();
  const { push, bottomInset, view } = useNavigation();
  const run = useRun();
  const [found, setFound] = useState<Discover | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const offline = offlineActive();
  useEffect(() => {
    if (offline) return;
    const abort = new AbortController();
    void discover(abort.signal).then(setFound).catch(failure => { if (!abort.signal.aborted) setDiscoverError(reason(failure, "Couldn't load recommendations.")); });
    return () => abort.abort();
  }, [offline, library.loadedAt]);
  const playOne = (track: Track, tracks: Track[], id: string) => run(() => changeQueue(queue => playEntries(queue,
    tracks.slice(tracks.indexOf(track)).map((item, index) => ({ globalTrackId: item.globalId, source: { kind: "search" as const, id, entryId: index + 1 } })), tracks), true));
  const trackCards = (tracks: Track[], id: string): Card[] => tracks.map(track => ({
    key: track.globalId, title: track.name, subtitle: track.artist, image: thumbnailArtwork(track), onPress: () => playOne(track, tracks, id),
  }));
  const recent = useMemo(() => [...library.history].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, 20).map(entry => entry.track), [library.history]);
  const downloaded = useMemo(() => [...phone.values()].map(phoneTrack), [phone]);
  const hour = new Date().getHours();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: bottomInset + 24 }}>
      <ScreenHeader title={hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"} subtitle={offline ? "Offline · your downloads still play" : view?.output ? `Playing on ${view.output.deviceName}` : undefined} />
      {offline ? <CardRow title="Downloads" cards={trackCards(downloaded, "downloads")} empty="Nothing is downloaded to this phone yet." /> : <>
        <CardRow title="Recently Played" cards={trackCards(recent, "recent")} empty="Songs you play show up here." />
        <CardRow title="Discover" cards={trackCards(found?.tracks ?? [], "discover")} empty={discoverError ?? (found ? "Keep listening and AMBRA will find more for you." : "Finding music for you…")} />
        <CardRow title="Your Playlists" empty="Create a playlist in Library." cards={[
          ...library.playlists.map(playlist => ({ key: playlist.id, title: playlist.name, subtitle: "AMBRA", image: thumbnailArtwork(playlistSongs(playlist, library)[0]), onPress: () => push({ kind: "playlist", id: playlist.id, name: playlist.name }) })),
          ...services.flatMap(service => library.servicePlaylists[service].map(playlist => ({ key: `${service}:${playlist.id}`, title: playlist.name, subtitle: musicProviderName(service), image: null, onPress: () => push({ kind: "playlist", id: playlist.id, provider: service, name: playlist.name }) }))),
        ]} />
        {downloaded.length > 0 && <CardRow title="On This Phone" cards={trackCards(downloaded, "downloads")} />}
      </>}
    </ScrollView>
  );
}

export { albumCard, artistCard };

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  overview: { flexDirection: "row", gap: 10, paddingHorizontal: 20, marginBottom: 12 },
  overviewCard: { flex: 1, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: "#2f2f2f", backgroundColor: "#111", padding: 14, gap: 6 },
  overviewTitle: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 13 },
  overviewCount: { color: "white", fontFamily: fonts.serif, fontSize: 28 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 56, paddingHorizontal: 22 },
  rowText: { flex: 1, gap: 3 },
  rowTitle: { color: "white", fontFamily: fonts.sans, fontSize: 15 },
  rowDetail: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12 },
  groupHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: 12 },
  group: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 12, fontWeight: "600", letterSpacing: 0.7, textTransform: "uppercase", paddingHorizontal: 22, paddingTop: 24, paddingBottom: 8 },
  newButton: { width: 44, height: 44, marginTop: 14, alignItems: "center", justifyContent: "center" },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 13, paddingHorizontal: 22, paddingBottom: 8 },
  loading: { padding: 16 },
  biography: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 14, lineHeight: 21, paddingHorizontal: 12, paddingTop: 16 },
  status: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, paddingHorizontal: 12, paddingBottom: 8 },
  listHeading: { color: "white", fontFamily: fonts.sans, fontSize: 20, fontWeight: "600", paddingHorizontal: 12, paddingTop: 20, paddingBottom: 8 },
});
