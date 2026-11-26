import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Animated, FlatList, Platform, RefreshControl, StyleSheet, Text, View, useAnimatedValue, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { Track } from "../../../desktop/src/types/music";
import { changeQueue, command, currentTrack, sessionView, thumbnailArtwork, type QueueItem } from "../client";
import { Icon } from "../Icons";
import { CompactBar, PageHeader, useNavigation, useNowPlaying, useRun } from "../navigation";
import { playEntries, playlistEntries, shuffledEntries } from "../queueModel";
import { serviceAllowed, servicePreferences, subscribeServicePreferences } from "../servicePreferences";
import { openMenu, type MenuAction } from "../shell/ContextMenu";
import { colors, fonts, haptic, radius, space, textSize } from "../theme";
import { Touchable, anchorOf, type Frame } from "../Touchable";
import { TrackRow } from "../TrackRow";
import { boundRows } from "../TrackBrowser";
import { useTrackMenus, type RemoveAction } from "../TrackMenus";
import { ReorderRow, moved, useReorder } from "../reorder";
import { CardArt } from "./Cards";

const AnimatedFlatList = Animated.createAnimatedComponent(FlatList<Track>);

function duration(tracks: Track[]) {
  const minutes = Math.round(tracks.reduce((sum, track) => sum + track.durationSeconds, 0) / 60);
  if (minutes <= 0) return "";
  return `  ·  ${minutes >= 60 ? `${Math.floor(minutes / 60)} hr ` : ""}${minutes % 60} min`;
}

/** A cover, or desktop's four-cover mosaic for playlists. */
export function CollectionArt({ tracks, image, round = false, size = 200 }: { tracks?: Track[]; image?: string | null; round?: boolean; size?: number }) {
  const covers = useMemo(() => image !== undefined ? [] : [...new Set((tracks ?? []).map(track => thumbnailArtwork(track)).filter(Boolean))].slice(0, 4) as string[], [tracks, image]);
  return <CardArt image={image ?? (covers.length < 4 ? covers[0] ?? null : null)} images={covers} size={size} round={round} />;
}

/**
 * Desktop's track collection page (TrackCollectionView) for a phone: the cover above the
 * title, Play, Shuffle and the collection's ⋯ menu, then its songs. Pull down and the cover
 * swells; scroll and the title settles into the bar at the top.
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
  const { bottomInset } = useNavigation();
  const { trackId: nowId, playing } = useNowPlaying();
  const run = useRun();
  const enabled = useSyncExternalStore(subscribeServicePreferences, servicePreferences);
  const [refreshing, setRefreshing] = useState(false);
  const scroll = useAnimatedValue(0);
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
  const { openSong, enqueue } = useTrackMenus(remove);
  const list = useRef<FlatList<Track>>(null);
  const reorder = useReorder({
    list: list as never,
    count: shown.length,
    onMove: (from, to) => {
      const ids = moved(shown.map(track => track.globalId), from, to);
      setDropped({ base: tracks, ids });
      run(() => onReorder!(ids), undefined, false);
    },
    renderLifted: index => shown[index] ? <TrackRow track={shown[index]} index={index} active={nowId === shown[index].globalId} playing={playing} onPress={() => {}} /> : null,
  });

  // Rows keep stable handlers, so a session update only redraws the rows whose state changed.
  const latest = useRef({ entries, shown });
  useLayoutEffect(() => { latest.current = { entries, shown }; });
  const onPress = useCallback((index: number) => {
    const { entries, shown } = latest.current;
    const view = sessionView();
    run(() => currentTrack(view)?.globalId === shown[index]?.globalId ? command(view?.playing ? "pause" : "play") : changeQueue(queue => playEntries(queue, entries.slice(index), shown), true));
  }, [run]);
  const onMenu = useCallback((index: number, frame: Frame) => {
    const { entries, shown } = latest.current;
    const view = sessionView();
    const track = shown[index];
    if (!track) return;
    const row = <TrackRow track={track} index={index} active={currentTrack(view)?.globalId === track.globalId} playing={!!view?.playing} onPress={() => {}} />;
    openSong(index, entries, shown, frame, row);
  }, [openSong]);
  const swipes = useCallback((index: number) => ({
    start: { icon: "playNext" as const, label: "Play Next", run: () => enqueue(index, latest.current.entries, latest.current.shown, true) },
    end: { icon: "addToQueue" as const, label: "Queue", run: () => enqueue(index, latest.current.entries, latest.current.shown, false) },
  }), [enqueue]);

  const play = (shuffle: boolean) => {
    // Shuffled once, so a conflict retry keeps the same order.
    const order = shuffle ? shuffledEntries(entries) : entries;
    run(() => changeQueue(queue => playEntries(queue, order, shown), true));
  };
  const listHeader = (
    <View onLayout={event => reorder.onRowsLayout(event.nativeEvent.layout.height)}>
      <PageHeader scroll={scroll} large={false} />
      <View style={styles.hero}>
        {/* Pulled past the top, the cover swells from its bottom edge. */}
        <Animated.View style={{ transformOrigin: "center bottom", transform: [{ scale: scroll.interpolate({ inputRange: [-240, 0], outputRange: [1.35, 1], extrapolateRight: "clamp" }) }] }}>{art}</Animated.View>
        <Text accessibilityRole="header" style={styles.title} numberOfLines={3} adjustsFontSizeToFit minimumFontScale={0.6}>{title}</Text>
        {subtitle && <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text>}
        <Text style={styles.summary}>{shown.length} {shown.length === 1 ? "song" : "songs"}{duration(shown)}</Text>
      </View>
      <View style={styles.actions}>
        <Touchable accessibilityRole="button" accessibilityLabel={`Play ${title}`} disabled={!shown.length} haptic="firm" hapticOnPressIn scale={0.93} onPress={() => play(false)} style={styles.play}>
          <Icon name="play" size={14} color={colors.black} /><Text style={styles.playLabel}>Play</Text>
        </Touchable>
        <Touchable accessibilityRole="button" accessibilityLabel={`Shuffle ${title}`} disabled={!shown.length} haptic="firm" hapticOnPressIn scale={0.93} onPress={() => play(true)} style={styles.shuffle}>
          <Icon name="shuffle" size={18} /><Text style={styles.shuffleLabel}>Shuffle</Text>
        </Touchable>
        {!!collectionActions?.length && <Touchable accessibilityRole="button" accessibilityLabel={`Options for ${title}`} haptic="select" scale={0.85}
          onPress={event => openMenu({ anchor: anchorOf(event), title, subtitle, actions: collectionActions })} style={styles.more}>
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
      <AnimatedFlatList
        ref={list}
        scrollEnabled={reorder.listProps.scrollEnabled}
        scrollEventThrottle={16}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scroll } } }], {
          useNativeDriver: true,
          listener: (event: NativeSyntheticEvent<NativeScrollEvent>) => reorder.listProps.onScroll(event),
        })}
        data={shown}
        keyExtractor={(track, index) => `${track.globalId}:${index}`}
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 16 }]}
        scrollIndicatorInsets={{ bottom: bottomInset }}
        extraData={`${nowId}:${playing}`}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={5}
        removeClippedSubviews={Platform.OS === "android"}
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={() => { haptic.tap(); setRefreshing(true); Promise.resolve(onRefresh()).finally(() => setRefreshing(false)); }} tintColor="white" /> : undefined}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={!loading && !error && empty ? <Text style={styles.empty}>{empty}</Text> : undefined}
        renderItem={({ item, index }) => {
          const swipe = swipes(index);
          const row = <TrackRow track={item} index={index} active={nowId === item.globalId} playing={playing} bound={bound.get(item.globalId)}
            onPress={onPress} onMenu={onMenu} swipeStart={swipe.start} swipeEnd={swipe.end} />;
          return <ReorderRow index={index} reorder={onReorder ? reorder : undefined} onHold={onMenu}>{row}</ReorderRow>;
        }}
      />
      {reorder.overlay}
      <CompactBar title={title} scroll={scroll} threshold={300} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  content: { paddingHorizontal: 12 },
  hero: { alignItems: "center", gap: space.sm, paddingHorizontal: 12, paddingBottom: 20 },
  title: { color: colors.text, fontFamily: fonts.serif, fontSize: 34, lineHeight: 40, fontWeight: "500", textAlign: "center", marginTop: 14 },
  subtitle: { color: colors.secondary, fontFamily: fonts.sans, fontSize: textSize.small, textAlign: "center" },
  summary: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.caption },
  actions: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, marginBottom: 10 },
  play: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: colors.text, borderRadius: radius.pill, height: 48 },
  shuffle: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, borderColor: "rgba(255, 255, 255, 0.35)", borderWidth: 1, borderRadius: radius.pill, height: 48 },
  more: { width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  playLabel: { color: colors.black, fontFamily: fonts.sans, fontWeight: "600", fontSize: 15 },
  shuffleLabel: { color: colors.text, fontFamily: fonts.sans, fontWeight: "600", fontSize: 15 },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: textSize.detail, lineHeight: 20, paddingHorizontal: 8, paddingVertical: 6 },
  loading: { paddingVertical: 32 },
  empty: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.small, lineHeight: 20, paddingVertical: 24, paddingHorizontal: 8, textAlign: "center" },
});
