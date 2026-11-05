import { Image } from "expo-image";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Platform, RefreshControl, StyleSheet, Text, View } from "react-native";
import type { Track } from "../../../desktop/src/types/music";
import { changeQueue, command, currentTrack, thumbnailArtwork, type QueueItem } from "../client";
import { useDownloads } from "../downloads";
import { Icon } from "../Icons";
import { Menu, type MenuAction } from "../Menu";
import { ScreenHeader, useNavigation, useRun } from "../navigation";
import { playEntries, playlistEntries, shuffledEntries } from "../queueModel";
import { serviceAllowed, servicePreferences, subscribeServicePreferences } from "../servicePreferences";
import { colors, fonts, haptic } from "../theme";
import { Touchable } from "../Touchable";
import { TrackRow, boundRows } from "../TrackBrowser";
import { useTrackMenus, type RemoveAction } from "../TrackMenus";
import { ReorderRow, moved, useReorder } from "../reorder";

const placeholder = require("../../assets/ambra.png");

function duration(tracks: Track[]) {
  const minutes = Math.round(tracks.reduce((sum, track) => sum + track.durationSeconds, 0) / 60);
  if (minutes <= 0) return "";
  return `  •  ${minutes >= 60 ? `${Math.floor(minutes / 60)} hr ` : ""}${minutes % 60} min`;
}

/** A cover, or desktop's four-cover mosaic for playlists. */
export function CollectionArt({ tracks, image, round = false, size = 132 }: { tracks?: Track[]; image?: string | null; round?: boolean; size?: number }) {
  const style = [styles.art, { width: size, height: size, borderRadius: round ? size / 2 : 12 }];
  if (image !== undefined || !tracks?.length) {
    return <Image source={image || placeholder} contentFit={image ? "cover" : "contain"} cachePolicy="disk" transition={0} style={style} />;
  }
  const covers = [...new Set(tracks.map(track => thumbnailArtwork(track)).filter(Boolean))].slice(0, 4) as string[];
  if (covers.length < 4) return <Image source={covers[0] || placeholder} contentFit="cover" cachePolicy="disk" transition={0} style={style} />;
  return <View style={[style, styles.mosaic]}>
    {covers.map(cover => <Image key={cover} source={cover} contentFit="cover" enforceEarlyResizing cachePolicy="disk" transition={0} style={styles.tile} />)}
  </View>;
}

/**
 * Desktop's track collection page (TrackCollectionView) for a phone: the cover above the
 * title, Play, Shuffle and the collection's ⋯ menu, then its songs.
 */
export function TrackListScreen({ title, subtitle, art, tracks, source, packages, loading = false, error, onRefresh, remove, collectionActions, empty, header, onReorder }: {
  title: string;
  subtitle?: string;
  art: ReactNode;
  tracks: Track[];
  source: { kind: "library" | "playlist" | "search"; id: string };
  /** Bound songs play and shuffle together. */
  packages?: string[][];
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  remove?: RemoveAction;
  collectionActions?: MenuAction[];
  empty?: string;
  /** Extra content under the buttons, like an artist's albums. */
  header?: ReactNode;
  /** Hold and drag songs to reorder them; gets the songs' new order. */
  onReorder?: (ids: string[]) => Promise<unknown>;
}) {
  const { view, bottomInset, onMenuVisibilityChange } = useNavigation();
  const run = useRun();
  const enabled = useSyncExternalStore(subscribeServicePreferences, servicePreferences);
  const { phone } = useDownloads();
  const [collectionMenu, setCollectionMenu] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // A drop shows at once; the saved order replaces it when it arrives.
  const [dropped, setDropped] = useState<{ base: Track[]; ids: string[] } | null>(null);
  const shown = useMemo(() => {
    const visible = tracks.filter(track => serviceAllowed(track.provider, enabled));
    if (dropped?.base !== tracks) return visible;
    const byId = new Map(visible.map(track => [track.globalId, track]));
    return dropped.ids.flatMap(id => byId.get(id) ?? []);
  }, [tracks, enabled, dropped]);
  const entries = useMemo<QueueItem[]>(() => packages
    ? playlistEntries({ id: source.id, name: title, trackIds: shown.map(track => track.globalId), packages }, shown)
    : shown.map((track, index) => ({ globalTrackId: track.globalId, source: { kind: source.kind, id: source.id, entryId: index + 1 } })),
  [shown, packages, source.kind, source.id, title]);
  const bound = useMemo(() => boundRows(packages ? { playlist: { id: source.id, name: title, trackIds: shown.map(track => track.globalId), packages }, tracks: shown } : null), [packages, shown, source.id, title]);
  const { openPlayback, openEdit, menus } = useTrackMenus(remove);
  const now = currentTrack(view);
  const playing = !!view?.playing;
  const list = useRef<FlatList<Track>>(null);
  const reorder = useReorder({
    list: list as never,
    count: shown.length,
    onMove: (from, to) => {
      const ids = moved(shown.map(track => track.globalId), from, to);
      setDropped({ base: tracks, ids });
      run(() => onReorder!(ids), undefined, false);
    },
    renderLifted: index => shown[index] ? <TrackRow track={shown[index]} index={index} active={now?.globalId === shown[index].globalId} playing={playing} downloaded={phone.has(shown[index].globalId)} onPress={() => {}} /> : null,
  });

  // Rows keep stable handlers, so a session update only redraws the rows whose state changed.
  const latest = useRef({ view, entries, shown });
  useLayoutEffect(() => { latest.current = { view, entries, shown }; });
  const onPress = useCallback((index: number) => {
    const { view, entries, shown } = latest.current;
    run(() => currentTrack(view)?.globalId === shown[index]?.globalId ? command(view?.playing ? "pause" : "play") : changeQueue(queue => playEntries(queue, entries.slice(index), shown), true));
  }, [run]);
  const onHold = useCallback((index: number) => openPlayback(index, latest.current.entries, latest.current.shown), [openPlayback]);
  const onMore = useCallback((index: number) => openEdit(latest.current.shown[index]), [openEdit]);

  const listHeader = (
    <View onLayout={event => reorder.onRowsLayout(event.nativeEvent.layout.height)}>
      <ScreenHeader />
      <View style={styles.hero}>
        {art}
        <Text accessibilityRole="header" style={styles.title} numberOfLines={3} adjustsFontSizeToFit minimumFontScale={0.6}>{title}</Text>
        {subtitle && <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text>}
        <Text style={styles.summary}>{shown.length} {shown.length === 1 ? "track" : "tracks"}{duration(shown)}</Text>
      </View>
      <View style={styles.actions}>
        <Touchable accessibilityRole="button" accessibilityLabel={`Play ${title}`} disabled={!shown.length} haptic="firm" hapticOnPressIn onPress={() => run(() => changeQueue(queue => playEntries(queue, entries, shown), true))} style={styles.play}>
          <Icon name="play" size={14} color="black" /><Text style={styles.playLabel}>PLAY</Text>
        </Touchable>
        <Touchable accessibilityRole="button" accessibilityLabel={`Shuffle ${title}`} disabled={!shown.length} haptic="firm" hapticOnPressIn onPress={() => {
          // Shuffled once, so a conflict retry keeps the same order.
          const shuffled = shuffledEntries(entries);
          run(() => changeQueue(queue => playEntries(queue, shuffled, shown), true));
        }} style={styles.shuffle}>
          <Icon name="shuffle" size={18} /><Text style={styles.shuffleLabel}>SHUFFLE</Text>
        </Touchable>
        {!!collectionActions?.length && <Touchable accessibilityRole="button" accessibilityLabel={`Options for ${title}`} haptic="select" onPress={() => setCollectionMenu(true)} style={styles.more}>
          <Icon name="more" rotation={90} size={18} />
        </Touchable>}
      </View>
      {header}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {loading && !shown.length && <ActivityIndicator color={colors.muted} style={styles.loading} />}
    </View>
  );

  return (
    <View style={styles.screen} {...reorder.containerProps}>
      <FlatList
        ref={list}
        {...reorder.listProps}
        data={shown}
        keyExtractor={(track, index) => `${track.globalId}:${index}`}
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 16 }]}
        scrollIndicatorInsets={{ bottom: bottomInset }}
        extraData={`${now?.globalId}:${playing}:${phone.size}`}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={5}
        removeClippedSubviews={Platform.OS === "android"}
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={() => { haptic.tap(); setRefreshing(true); Promise.resolve(onRefresh()).finally(() => setRefreshing(false)); }} tintColor="white" /> : undefined}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={!loading && !error ? <Text style={styles.empty}>{empty ?? "No songs here yet."}</Text> : undefined}
        renderItem={({ item, index }) => {
          const row = <TrackRow track={item} index={index} active={now?.globalId === item.globalId} playing={playing} bound={bound.get(item.globalId)} downloaded={phone.has(item.globalId)} holdDrags={!!onReorder} onPress={onPress} onHold={onHold} onMore={onMore} />;
          return onReorder ? <ReorderRow index={index} reorder={reorder} enabled onHold={onHold}>{row}</ReorderRow> : row;
        }}
      />
      {reorder.overlay}
      {menus}
      {collectionMenu && collectionActions && <Menu title={title} subtitle={subtitle} actions={collectionActions} onClose={() => setCollectionMenu(false)} onVisibilityChange={onMenuVisibilityChange} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  content: { paddingHorizontal: 12 },
  hero: { alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 20 },
  art: { backgroundColor: "#141414", overflow: "hidden", borderCurve: "continuous", marginBottom: 10 },
  mosaic: { flexDirection: "row", flexWrap: "wrap" },
  tile: { width: "50%", height: "50%" },
  title: { color: "white", fontFamily: fonts.serif, fontSize: 34, lineHeight: 40, fontWeight: "500", textAlign: "center" },
  subtitle: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 14, textAlign: "center" },
  summary: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12 },
  actions: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, marginBottom: 14 },
  play: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: "white", borderRadius: 100, height: 46 },
  shuffle: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, borderColor: "white", borderWidth: 1, borderRadius: 100, height: 46 },
  more: { width: 46, height: 46, borderRadius: 23, borderWidth: 1, borderColor: "#3a3a3a", alignItems: "center", justifyContent: "center" },
  playLabel: { color: "black", fontFamily: fonts.sans, fontWeight: "600", fontSize: 15 },
  shuffleLabel: { color: "white", fontFamily: fonts.sans, fontWeight: "600", fontSize: 15 },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, paddingHorizontal: 8, paddingVertical: 6 },
  loading: { paddingVertical: 32 },
  empty: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, paddingVertical: 24, paddingHorizontal: 8, textAlign: "center" },
});
