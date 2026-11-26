import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, RefreshControl, StyleSheet, Text, View, useAnimatedValue } from "react-native";
import type { CatalogAlbum, CatalogArtist } from "../../../desktop/src/api/server";
import type { Track } from "../../../desktop/src/types/music";
import { musicProviderName } from "../../../desktop/src/utils/musicProviderName";
import { sortAlbumTracks, tracksForEntity } from "../../../desktop/src/utils/browse";
import { changeQueue, directMode, offlineActive, thumbnailArtwork } from "../client";
import { phoneTrack, removePhoneDownloads, useDownloads } from "../downloads";
import { Icon, type IconName } from "../Icons";
import {
  albumTracks, artistAlbums, artistProfile, createPlaylist, deletePlaylist, deleteServicePlaylist, discover, duplicatePlaylist,
  libraryAlbums, libraryArtists, playlistSongs, providerRecommendations, recommendationArtwork, recommendationMix, refreshLibrary, removeFromLibrary,
  removeFromPlaylist, removeFromServicePlaylist, renamePlaylist, renameServicePlaylist, reorderLibrary, reorderPlaylist, servicePlaylistContents, useLibrary,
  type ArtistProfile, type Discover, type ProviderRecommendations, type RecommendationMix, type ServicePlaylistContents,
} from "../library";
import { CompactBar, PageHeader, reason, showToast, useNavigation, useNowPlaying, useRun, type Route } from "../navigation";
import { playEntries } from "../queueModel";
import { services, type Service } from "../servicePreferences";
import type { MenuAction } from "../shell/ContextMenu";
import { Segmented } from "../shell/Segmented";
import { PromptSheet, openDownloadSheet } from "../Sheets";
import { colors, fonts, radius, textSize } from "../theme";
import { Touchable } from "../Touchable";
import { useTrackMenus } from "../TrackMenus";
import { CardArt, CardGrid, CardRow, type Card } from "./Cards";
import { CollectionArt, TrackListScreen } from "./TrackListScreen";
import { exportPlaylist, importMusic, improvePlaylist } from "../playlistTools";

const albumCard = (album: CatalogAlbum, push: (route: Route) => void): Card => ({
  key: album.id, title: album.title, subtitle: [album.artist, album.releaseDate?.slice(0, 4)].filter(Boolean).join(" · "), image: album.imageUrl,
  onPress: () => push({ kind: "album", album }),
});
const artistCard = (artist: CatalogArtist & { trackCount?: number }, push: (route: Route) => void): Card => ({
  key: artist.id, title: artist.name, subtitle: artist.trackCount ? `${artist.trackCount} ${artist.trackCount === 1 ? "song" : "songs"}` : undefined,
  image: artist.imageUrl, round: true, onPress: () => push({ kind: "artist", artist }),
});
const songs = (count: number) => `${count} ${count === 1 ? "song" : "songs"}`;

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
  const actions: MenuAction[] = offlineActive() ? [] : [
    ...(editable ? [{ label: "Rename Playlist", icon: "edit" as const, run: () => setPrompt({ title: "Rename playlist", initial: title, confirmLabel: "Save",
      onSubmit: value => provider ? renameServicePlaylist(provider, id, value).then(() => setReload(count => count + 1)) : renamePlaylist(id, value) }) }] : []),
    { label: "Duplicate Playlist", icon: "duplicate", run: () => void duplicatePlaylist(title, tracks).then(() => showToast("Playlist duplicated")).catch(failure => showToast(reason(failure, "Couldn't duplicate this playlist."), true)) },
    { label: "Download Playlist", icon: "download", disabled: !tracks.length, run: () => openDownloadSheet(tracks, title) },
    ...(ambra ? [{ label: improving ? "Improving…" : "Improve Playlist", icon: "sparkle" as const, disabled: !!improving || !tracks.length, run: () => {
      const controller = new AbortController();
      improvement.current = controller;
      setStatus(null);
      setImproving({ done: 0, total: tracks.length });
      void improvePlaylist(ambra, (done, total) => setImproving({ done, total }), controller.signal)
        .then(upgraded => setStatus(upgraded ? `Moved ${songs(upgraded)} to ${upgraded === 1 ? "a better copy" : "better copies"}.` : "Every song is already on the best copy available."))
        .catch(failure => { if (!controller.signal.aborted) setStatus(reason(failure, "Could not reach your music services. Please try again.")); })
        .finally(() => setImproving(null));
    } }] : []),
    { label: "Export Playlist", icon: "duplicate", disabled: !tracks.length, run: () => void exportPlaylist(title, tracks).catch(failure => showToast(reason(failure, "Couldn't export this playlist."), true)) },
    ...(editable ? [{ label: "Delete Playlist", icon: "remove" as const, destructive: true, run: () => setPrompt({ title: "Delete playlist?", message: `Delete “${title}”? This can't be undone.`, confirmLabel: "Delete", destructive: true,
      onSubmit: () => (provider ? deleteServicePlaylist(provider, id) : deletePlaylist(id)).then(back) }) }] : []),
  ];
  const remove = !editable ? undefined : {
    label: "Remove from Playlist",
    run: (track: Track) => provider && contents
      ? removeFromServicePlaylist(provider, id, contents.entries.filter(entry => entry.trackId === track.globalId || entry.trackId === track.providerTrackId).map(entry => entry.id), contents.revision).then(() => setReload(count => count + 1))
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
      onRefresh={() => provider ? setReload(count => count + 1) : refreshLibrary()}
      remove={remove}
      collectionActions={actions}
      onReorder={ambra && !offlineActive() ? ids => reorderPlaylist(id, ids) : undefined}
      header={improving || status ? <Text accessibilityRole="alert" style={styles.status}>{improving ? `Checking ${improving.done} of ${improving.total} songs…` : status}</Text> : undefined}
    />
    {prompt && <PromptSheet {...prompt} onClose={() => setPrompt(null)} />}
  </>;
}

/** One of a service's mixes from its home (desktop's mix view). */
export function MixScreen({ provider, mix }: { provider: Service; mix: RecommendationMix }) {
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void recommendationMix(provider, mix.id, abort.signal).then(value => { setTracks(value); setError(null); })
      .catch(failure => { if (!abort.signal.aborted) setError(reason(failure, "Couldn't load this mix.")); });
    return () => abort.abort();
  }, [provider, mix.id, attempt]);
  const shown = tracks ?? [];
  return <TrackListScreen
    title={mix.title}
    subtitle={`${musicProviderName(provider)} mix`}
    art={mix.imageUrl ? <CollectionArt image={mix.imageUrl} /> : <CollectionArt tracks={shown} />}
    tracks={shown}
    source={{ kind: "search", id: `mix:${provider}:${mix.id}` }}
    loading={!tracks && !error}
    error={error}
    onRefresh={() => setAttempt(count => count + 1)}
    collectionActions={offlineActive() ? [] : [{ label: "Download Mix", icon: "download", disabled: !shown.length, run: () => openDownloadSheet(shown, mix.title) }]}
  />;
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
    art={<CollectionArt image={album.imageUrl ?? (shown[0] ? thumbnailArtwork(shown[0]) : null)} size={220} />}
    tracks={shown}
    source={{ kind: "search", id: `album:${album.id}` }}
    loading={!tracks && !error}
    error={error}
    collectionActions={offlineActive() ? [] : [{ label: "Download Album", icon: "download", disabled: !shown.length, run: () => openDownloadSheet(shown, album.title) }]}
  />;
}

/** An artist's popular songs, then their albums, as desktop's artist page. */
export function ArtistScreen({ artist }: { artist: CatalogArtist }) {
  const { push } = useNavigation();
  const [profile, setProfile] = useState<ArtistProfile | null>(null);
  const [albums, setAlbums] = useState<CatalogAlbum[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
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
    art={<CollectionArt image={shown.imageUrl} round size={180} />}
    tracks={popular}
    source={{ kind: "search", id: `artist:${artist.id}` }}
    loading={!profile && !error}
    error={error ?? profile?.popularTracksError}
    header={<>
      {profile?.biography && <Touchable accessibilityRole="button" accessibilityLabel={expanded ? "Show less" : "Read more"} haptic="tick" scale={0.98} onPress={() => setExpanded(value => !value)}>
        <Text style={styles.biography} numberOfLines={expanded ? undefined : 4}>{profile.biography}</Text>
      </Touchable>}
      {albums.length > 0 && <View style={styles.bleed}><CardRow title="Albums" cards={albums.map(album => albumCard(album, push))} /></View>}
      {popular.length > 0 && <Text style={styles.listHeading}>Popular</Text>}
    </>}
  />;
}

/** Library › Tracks, Artists or Albums. */
export function SectionScreen({ section }: { section: "artists" | "albums" | "tracks" }) {
  const library = useLibrary();
  const { push, bottomInset } = useNavigation();
  const scroll = useAnimatedValue(0);
  if (section === "tracks") {
    return <TrackListScreen
      title="Songs"
      art={<CollectionArt tracks={library.tracks} />}
      tracks={library.tracks}
      source={{ kind: "library", id: "library" }}
      loading={library.loading}
      error={library.error}
      onRefresh={refreshLibrary}
      remove={{ label: "Remove from Library", run: track => removeFromLibrary([track]) }}
      onReorder={offlineActive() ? undefined : reorderLibrary}
      collectionActions={offlineActive() ? [] : [{ label: "Download Library", icon: "download", disabled: !library.tracks.length, run: () => openDownloadSheet(library.tracks, "your library") }]}
    />;
  }
  const cards = section === "artists"
    ? libraryArtists(library.tracks).map(artist => artistCard(artist, push))
    : libraryAlbums(library.tracks).map(album => albumCard(album, push));
  const title = section === "artists" ? "Artists" : "Albums";
  return <View style={styles.screen}>
    <CardGrid cards={cards} bottomInset={bottomInset} onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scroll } } }], { useNativeDriver: false })}
      header={<PageHeader title={title} subtitle={`${cards.length} ${section}`} scroll={scroll} />} />
    <CompactBar title={title} scroll={scroll} />
  </View>;
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
  />;
}

function Row({ title, detail, icon, art, onPress }: { title: string; detail?: string; icon?: IconName; art?: React.ReactNode; onPress(): void }) {
  return (
    <Touchable accessibilityRole="button" accessibilityLabel={[title, detail].filter(Boolean).join(", ")} highlight haptic="select" scale={0.98} onPress={onPress} style={styles.row}>
      {art ?? (icon && <View style={styles.rowIcon}><Icon name={icon} size={18} color={colors.secondary} /></View>)}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
        {detail && <Text style={styles.rowDetail} numberOfLines={1}>{detail}</Text>}
      </View>
      <Icon name="back" rotation={180} size={12} color={colors.faint} />
    </Touchable>
  );
}

function RoundButton({ icon, label, onPress }: { icon: IconName; label: string; onPress(): void }) {
  return <Touchable accessibilityRole="button" accessibilityLabel={label} haptic="tap" scale={0.82} onPress={onPress} style={styles.roundButton}><Icon name={icon} size={18} /></Touchable>;
}

/** Desktop's library overview and sidebar playlists, together on one page. */
export function LibraryScreen() {
  const library = useLibrary();
  const { phone } = useDownloads();
  const { push, bottomInset } = useNavigation();
  const scroll = useAnimatedValue(0);
  const [prompt, setPrompt] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  const offline = offlineActive();
  const artists = useMemo(() => libraryArtists(library.tracks).length, [library.tracks]);
  const albums = useMemo(() => libraryAlbums(library.tracks).length, [library.tracks]);
  const covers = (trackIds: string[]) => trackIds.map(id => library.playlistTracks.get(id) ?? library.tracks.find(track => track.globalId === id)).map(track => thumbnailArtwork(track)).filter((url): url is string => !!url).slice(0, 4);
  return <View style={styles.screen}>
    <Animated.ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: bottomInset + 24 }} scrollEventThrottle={16}
      onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scroll } } }], { useNativeDriver: true })}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void refreshLibrary().finally(() => setRefreshing(false)); }} tintColor="white" />}>
      <PageHeader title="Library" subtitle={offline ? "Offline · showing songs on this phone" : undefined} scroll={scroll}
        right={<View style={styles.headerButtons}>
          {!offline && <RoundButton icon="add" label="New playlist" onPress={() => setPrompt(true)} />}
          <RoundButton icon="settings" label="Settings" onPress={() => push({ kind: "settings" })} />
        </View>} />
      {!offline && <>
        <View style={styles.overview}>
          {([["tracks", "Songs", library.tracks.length], ["artists", "Artists", artists], ["albums", "Albums", albums]] as const).map(([section, label, count]) => (
            <Touchable key={section} accessibilityRole="button" accessibilityLabel={`${label}, ${count}`} scale={0.94} haptic="select" onPress={() => push({ kind: "section", section })} style={styles.overviewCard}>
              <Text style={styles.overviewCount}>{count}</Text>
              <Text style={styles.overviewTitle}>{label}</Text>
            </Touchable>
          ))}
        </View>
        {library.error && <Text accessibilityRole="alert" style={styles.error}>{library.error}</Text>}
      </>}
      <Row title="Downloads" detail={`${songs(phone.size)} on this phone`} icon="download" onPress={() => push({ kind: "downloads" })} />
      {!offline && !directMode && <Row title={importing ? `Importing ${importing.done} of ${importing.total}…` : "Import Music"} detail="Add music files from this phone to your library" icon="add" onPress={() => {
        if (importing) return;
        void importMusic((done, total) => setImporting({ done, total })).then(({ imported, failed }) => {
          if (failed.length) showToast(`${imported} imported, ${failed.length} failed: ${failed[0]}`, true);
          else if (imported) showToast(`Imported ${songs(imported)}`);
        }).catch(failure => showToast(reason(failure, "Couldn't import music."), true)).finally(() => setImporting(null));
      }} />}
      {!offline && <>
        <Text style={styles.group}>Playlists</Text>
        {library.loading && !library.loadedAt && <ActivityIndicator color={colors.muted} style={styles.loading} />}
        {library.playlists.map(playlist => <Row key={playlist.id} title={playlist.name} detail={`AMBRA · ${songs(playlist.trackIds.length)}`}
          art={<CardArt image={null} images={covers(playlist.trackIds)} size={48} />}
          onPress={() => push({ kind: "playlist", id: playlist.id, name: playlist.name })} />)}
        {services.map(service => library.servicePlaylists[service].length > 0 && <View key={service}>
          <Text style={styles.group}>{musicProviderName(service)}</Text>
          {library.servicePlaylists[service].map(playlist => <Row key={playlist.id} title={playlist.name} detail={songs(playlist.trackCount)}
            art={<CardArt image={null} size={48} />}
            onPress={() => push({ kind: "playlist", id: playlist.id, provider: service, name: playlist.name })} />)}
        </View>)}
      </>}
    </Animated.ScrollView>
    <CompactBar title="Library" scroll={scroll} />
    {prompt && <PromptSheet title="New playlist" initial="" confirmLabel="Create" onSubmit={value => createPlaylist(value)} onClose={() => setPrompt(false)} />}
  </View>;
}

/** A service's own home: its mixes in their sections, and the albums it suggests. */
function ProviderHome({ provider }: { provider: Service }) {
  const { push } = useNavigation();
  const [value, setValue] = useState<ProviderRecommendations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [art, setArt] = useState<Record<string, { imageUrl: string | null; albumImageUrls?: string[] }>>({});
  useEffect(() => {
    const abort = new AbortController();
    void providerRecommendations(provider, abort.signal).then(found => {
      setValue(found);
      // Mixes without a cover borrow one from the server, as desktop's cards do.
      for (const mix of found.mixes.filter(item => item.artworkFallback && !item.imageUrl)) {
        void recommendationArtwork(provider, mix.id, abort.signal).then(result => setArt(current => ({ ...current, [mix.id]: result }))).catch(() => {});
      }
    }).catch(failure => { if (!abort.signal.aborted) setError(reason(failure, `Couldn't load ${musicProviderName(provider)} recommendations.`)); });
    return () => abort.abort();
  }, [provider]);
  const fallback = provider === "qobuz" ? "Your mixes" : "Made for you";
  const sections = new Map<string, RecommendationMix[]>();
  for (const mix of value?.mixes ?? []) sections.set(mix.section || fallback, [...(sections.get(mix.section || fallback) ?? []), mix]);
  const albums = (value?.albums ?? []).filter(album => album.provider === provider)
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.title.localeCompare(b.title));
  return <>
    {!sections.size && <CardRow title={fallback} cards={[]} empty={error ?? (value ? undefined : "Loading recommendations…")} />}
    {[...sections].map(([title, mixes]) => <CardRow key={title} title={title} cards={mixes.map(mix => {
      const imageUrl = mix.imageUrl ?? art[mix.id]?.imageUrl ?? null;
      return { key: mix.id, title: mix.title, image: imageUrl, images: art[mix.id]?.albumImageUrls, onPress: () => push({ kind: "mix", provider, mix: { ...mix, imageUrl } }) };
    })} />)}
    {albums.length > 0 && <CardRow title={provider === "qobuz" ? "Release Watch" : "Recommended albums"} cards={albums.map(album => albumCard(album, push))} />}
  </>;
}

/** Desktop's home: what you played, your playlists, what to discover; or a service's own home. */
export function HomeScreen() {
  const library = useLibrary();
  const { phone } = useDownloads();
  const { push, bottomInset } = useNavigation();
  const { outputName } = useNowPlaying();
  const run = useRun();
  const { openPlayback } = useTrackMenus();
  const scroll = useAnimatedValue(0);
  const [source, setSource] = useState<"ambra" | Service>("ambra");
  const [found, setFound] = useState<Discover | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const offline = offlineActive();
  const connected = services.filter(service => library.connected?.[service]);
  const shownSource = source !== "ambra" && connected.includes(source) ? source : "ambra";
  useEffect(() => {
    if (offline) return;
    const abort = new AbortController();
    void discover(abort.signal).then(setFound).catch(failure => { if (!abort.signal.aborted) setDiscoverError(reason(failure, "Couldn't load recommendations.")); });
    return () => abort.abort();
  }, [offline, library.loadedAt]);
  const entriesFor = (tracks: Track[], id: string) => tracks.map((item, index) => ({ globalTrackId: item.globalId, source: { kind: "search" as const, id, entryId: index + 1 } }));
  const trackCards = (tracks: Track[], id: string): Card[] => tracks.map((track, index) => ({
    key: track.globalId, title: track.name, subtitle: track.artist, image: thumbnailArtwork(track),
    onPress: () => run(() => changeQueue(queue => playEntries(queue, entriesFor(tracks, id).slice(index), tracks), true)),
    onLongPress: anchor => openPlayback(index, entriesFor(tracks, id), tracks, anchor),
  }));
  const ordered = useMemo(() => [...library.history].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt), [library.history]);
  // Desktop's split: the last month, and older songs worth coming back to.
  const [cutoff] = useState(() => Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recent = useMemo(() => ordered.filter(entry => entry.lastPlayedAt > cutoff).slice(0, 20).map(entry => entry.track), [ordered, cutoff]);
  const older = useMemo(() => ordered.filter(entry => entry.lastPlayedAt <= cutoff).reverse().slice(0, 20).map(entry => entry.track), [ordered, cutoff]);
  const downloaded = useMemo(() => [...phone.values()].map(phoneTrack), [phone]);
  const covers = (trackIds: string[]) => trackIds.map(id => library.playlistTracks.get(id)).map(track => thumbnailArtwork(track)).filter((url): url is string => !!url).slice(0, 4);
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <View style={styles.screen}>
      <Animated.ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: bottomInset + 24 }} scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scroll } } }], { useNativeDriver: true })}>
        <PageHeader title={greeting} scroll={scroll}
          subtitle={offline ? "Offline · your downloads still play" : outputName ? `Playing on ${outputName}` : undefined}
          right={<RoundButton icon="settings" label="Settings" onPress={() => push({ kind: "settings" })} />} />
        {!offline && connected.length > 0 && <Segmented<"ambra" | Service> label="Recommendations from" value={shownSource} onChange={setSource}
          items={[{ value: "ambra" as const, label: "AMBRA" }, ...connected.map(service => ({ value: service, label: musicProviderName(service) }))]} />}
        {offline ? <CardRow title="Downloads" cards={trackCards(downloaded, "downloads")} />
          : shownSource !== "ambra" ? <ProviderHome key={shownSource} provider={shownSource} /> : <>
            <CardRow title="Recently Played" cards={trackCards(recent, "recent")} />
            <CardRow title="Your Playlists" cards={[
              ...library.playlists.map(playlist => ({ key: playlist.id, title: playlist.name, subtitle: songs(playlist.trackIds.length), image: null, images: covers(playlist.trackIds), onPress: () => push({ kind: "playlist", id: playlist.id, name: playlist.name }) })),
              ...services.flatMap(service => library.servicePlaylists[service].map(playlist => ({ key: `${service}:${playlist.id}`, title: playlist.name, subtitle: musicProviderName(service), image: null, onPress: () => push({ kind: "playlist", id: playlist.id, provider: service, name: playlist.name }) }))),
            ]} />
            {older.length > 0 && <CardRow title="Haven’t Played in a While" cards={trackCards(older, "older")} />}
            <CardRow title="Discover" cards={trackCards(found?.tracks ?? [], "discover")} empty={discoverError ?? (found ? undefined : "Finding music for you…")} />
            {downloaded.length > 0 && <CardRow title="On This Phone" cards={trackCards(downloaded, "downloads")} />}
          </>}
      </Animated.ScrollView>
      <CompactBar title={greeting} scroll={scroll} />
    </View>
  );
}

export { albumCard, artistCard };

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  headerButtons: { flexDirection: "row", gap: 8, paddingBottom: 6 },
  roundButton: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: colors.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  overview: { flexDirection: "row", gap: 10, paddingHorizontal: 20, marginBottom: 14 },
  overviewCard: { flex: 1, borderRadius: radius.lg, borderCurve: "continuous", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.raised, padding: 14, gap: 2 },
  overviewTitle: { color: colors.secondary, fontFamily: fonts.sans, fontSize: textSize.detail },
  overviewCount: { color: colors.text, fontFamily: fonts.serif, fontSize: 30, fontVariant: ["tabular-nums"] },
  row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 64, paddingHorizontal: 20, paddingVertical: 8 },
  rowIcon: { width: 48, height: 48, borderRadius: radius.md, borderCurve: "continuous", alignItems: "center", justifyContent: "center", backgroundColor: colors.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  rowText: { flex: 1, gap: 3 },
  rowTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 15 },
  rowDetail: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.caption },
  group: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.heading, fontWeight: "600", paddingHorizontal: 20, paddingTop: 26, paddingBottom: 6 },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: textSize.detail, paddingHorizontal: 20, paddingBottom: 8 },
  empty: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.small, paddingHorizontal: 20, paddingVertical: 8 },
  loading: { padding: 16 },
  bleed: { marginHorizontal: -12 },
  biography: { color: colors.secondary, fontFamily: fonts.sans, fontSize: textSize.small, lineHeight: 21, paddingHorizontal: 8, paddingBottom: 4 },
  status: { color: colors.secondary, fontFamily: fonts.sans, fontSize: textSize.detail, lineHeight: 19, paddingHorizontal: 12, paddingBottom: 8 },
  listHeading: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.heading, fontWeight: "600", paddingHorizontal: 8, paddingTop: 20, paddingBottom: 8 },
});
