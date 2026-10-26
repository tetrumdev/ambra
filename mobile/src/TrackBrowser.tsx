import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, FlatList, Platform, RefreshControl, StyleSheet, Text, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Artwork } from "./Artwork";
import { changeQueue, command, currentTrack, megaPlaylist, serverAddress, subscribe, thumbnailArtwork, type PlaylistContents, type QueueItem, type SessionView, type Track } from "./client";
import { Icon } from "./Icons";
import { Menu, type MenuAction } from "./Menu";
import { editUpcoming, enqueueEntries, playEntries, playlistEntries, shuffledEntries } from "./queueModel";
import { Sheet } from "./Sheet";
import { colors, fonts, haptic } from "./theme";
import { Touchable } from "./Touchable";

const placeholder = require("../assets/ambra.png");
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
const playFrom = (entries: QueueItem[], tracks: Track[], index: number) => changeQueue(queue => playEntries(queue, entries.slice(index), tracks), true);

type Toast = { id: number; text: string; error: boolean };
/** Brief word that something off-screen happened, like a song joining the queue. */
function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((text: string, error = false) => {
    clearTimeout(timer.current);
    setToast({ id: Date.now(), text, error });
    timer.current = setTimeout(() => setToast(null), 2200);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [toast, show] as const;
}

function ToastView({ toast, bottom }: { toast: Toast | null; bottom: number }) {
  if (!toast) return null;
  return (
    <Animated.View key={toast.id} entering={FadeInDown.duration(220)} exiting={FadeOut.duration(160)} pointerEvents="none" style={[styles.toast, { bottom }]}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.toastText, toast.error && { color: colors.error }]}>{toast.text}</Text>
    </Animated.View>
  );
}

type Bound = "first" | "middle" | "last";
/** Where each song sits in the songs bound with it; a package with one playable song isn't shown. */
function boundRows(contents: PlaylistContents | null) {
  const rows = new Map<string, Bound>();
  const playable = new Set(contents?.tracks.map(track => track.globalId));
  for (const pack of contents?.playlist.packages ?? []) {
    const shown = pack.filter(id => playable.has(id));
    if (shown.length < 2) continue;
    shown.forEach((id, at) => rows.set(id, at === 0 ? "first" : at === shown.length - 1 ? "last" : "middle"));
  }
  return rows;
}

const TrackRow = memo(function TrackRow({ track, index, active, playing, bound, onPress, onMore }: {
  track: Track;
  index: number;
  active: boolean;
  playing: boolean;
  /** Bound songs read as one block, in desktop's amber (.libraryItem[data-package]). */
  bound?: Bound;
  onPress: (index: number) => void;
  onMore?: (index: number) => void;
}) {
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${active ? (playing ? "Pause" : "Resume") : "Play"} ${track.name}, ${track.artist}`}
      accessibilityHint={[bound && "Bound with the songs around it.", onMore && "Hold for more options."].filter(Boolean).join(" ") || undefined}
      accessibilityState={{ selected: active }}
      highlight
      scale={0.98}
      haptic="select"
      unstable_pressDelay={40}
      onPress={() => onPress(index)}
      onLongPress={onMore && (() => onMore(index))}
      style={[styles.trackRow, bound && styles[bound]]}
    >
      {bound && <LinearGradient pointerEvents="none" colors={["rgba(53, 32, 0, 0.5)", "transparent"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />}
      <Artwork track={track} />
      <View style={styles.trackText}>
        <Text numberOfLines={1} style={[styles.trackName, active && styles.activeName]}>{track.name}</Text>
        <Text numberOfLines={1} style={styles.trackArtist}>{track.artist}</Text>
      </View>
      {active ? <Icon name={playing ? "pause" : "play"} size={12} /> : <Text style={styles.duration}>{clock(track.durationSeconds)}</Text>}
      {onMore ? <Touchable accessibilityRole="button" accessibilityLabel={`Options for ${track.name}`} haptic="select" hitSlop={6} onPress={() => onMore(index)} style={styles.more}>
        <Icon name="more" rotation={90} size={16} color={colors.muted} />
      </Touchable> : <View style={styles.moreSpacer} />}
    </Touchable>
  );
});

/** MEGA, as desktop's playlist page: tap a song to play from it, hold it for its options. */
export const PlaylistBrowser = memo(function PlaylistBrowser({ view, bottomInset, onMenuVisibilityChange }: { view: SessionView | null; bottomInset: number; onMenuVisibilityChange?: (visible: boolean) => void }) {
  const insets = useSafeAreaInsets();
  const [contents, setContents] = useState<PlaylistContents | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [toast, showToast] = useToast();
  const address = useSyncExternalStore(subscribe, serverAddress);

  // Loaded once (and again on another network, since its artwork points at the server's address), not each time the player closes: parsing the saved library is the heaviest work the app does.
  useEffect(() => {
    const abort = new AbortController();
    void megaPlaylist(abort.signal).then(value => {
      if (abort.signal.aborted) return;
      setContents(value);
      setLoadError(null);
    }).catch(reason => {
      if (!abort.signal.aborted) setLoadError(message(reason, "Couldn't load MEGA."));
    }).finally(() => {
      if (abort.signal.aborted) return;
      setLoading(false);
      setRefreshing(false);
    });
    return () => abort.abort();
  }, [reload, address]);

  const tracks = useMemo(() => contents?.tracks ?? [], [contents]);
  const entries = useMemo(() => contents ? playlistEntries(contents.playlist, contents.tracks) : [], [contents]);
  const bound = useMemo(() => boundRows(contents), [contents]);
  const now = currentTrack(view);
  const playing = !!view?.playing;

  // Rows keep stable handlers, so a session update only redraws the rows whose state changed.
  const latest = useRef({ view, entries, tracks });
  useLayoutEffect(() => { latest.current = { view, entries, tracks }; });
  const run = useCallback((work: () => Promise<void>, done?: string) => {
    if (!latest.current.view?.output) {
      haptic.warning();
      showToast("Choose an output in the player first");
      return;
    }
    void work().then(() => {
      if (!done) return;
      haptic.success();
      showToast(done);
    }).catch(reason => {
      haptic.error();
      showToast(message(reason, "Couldn't update playback. Please try again."), true);
    });
  }, [showToast]);
  const onPress = useCallback((index: number) => {
    const { view, entries, tracks } = latest.current;
    run(() => currentTrack(view)?.globalId === tracks[index]?.globalId ? command(view?.playing ? "pause" : "play") : playFrom(entries, tracks, index));
  }, [run]);
  const onMore = useCallback((index: number) => setMenu(index), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // Like desktop, adding to an empty queue starts it.
  const enqueue = (index: number, next: boolean) =>
    run(() => changeQueue(queue => enqueueEntries(queue, [entries[index]], [tracks[index]], next), !view?.queue.current), next ? "Playing next" : "Added to queue");
  const menuActions = (index: number): MenuAction[] => [
    { label: "Standalone Play", icon: "play", run: () => run(() => changeQueue(queue => playEntries(queue, [entries[index]], [tracks[index]]), true)) },
    { label: "Play from Here", icon: "skip", run: () => run(() => playFrom(entries, tracks, index)) },
    { label: "Play Next", icon: "playNext", run: () => enqueue(index, true) },
    { label: "Add to Queue", icon: "addToQueue", run: () => enqueue(index, false) },
  ];

  const totalMinutes = Math.round(tracks.reduce((sum, track) => sum + track.durationSeconds, 0) / 60);
  const empty = !tracks.length;
  const header = (
    <View style={{ paddingTop: insets.top + 24 }}>
      <View style={styles.hero}>
        <View style={styles.mosaic}>
          {Array.from({ length: 4 }, (_, index) => <Image key={index} source={thumbnailArtwork(tracks[index]) || placeholder} contentFit={tracks[index]?.cover ? "cover" : "contain"} enforceEarlyResizing cachePolicy="disk" transition={0} style={styles.tile} />)}
        </View>
        <View style={styles.heroText}>
          <Text style={styles.title} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6}>{contents?.playlist.name ?? "MEGA"}</Text>
          {contents && <Text style={styles.summary}>{tracks.length} {tracks.length === 1 ? "track" : "tracks"}{totalMinutes > 0 ? `  •  ${totalMinutes >= 60 ? `${Math.floor(totalMinutes / 60)} hr ` : ""}${totalMinutes % 60} min` : ""}</Text>}
        </View>
      </View>
      <View style={styles.playActions}>
        <Touchable accessibilityRole="button" accessibilityLabel={`Play ${contents?.playlist.name ?? "MEGA"}`} disabled={empty} haptic="firm" hapticOnPressIn onPress={() => run(() => playFrom(entries, tracks, 0))} style={styles.playButton}>
          <Icon name="play" size={14} color="black" />
          <Text style={styles.playLabel}>PLAY</Text>
        </Touchable>
        <Touchable accessibilityRole="button" accessibilityLabel={`Shuffle ${contents?.playlist.name ?? "MEGA"}`} disabled={empty} haptic="firm" hapticOnPressIn onPress={() => {
          // Shuffled once, so a conflict retry keeps the same order.
          const shuffled = shuffledEntries(entries);
          run(() => changeQueue(queue => playEntries(queue, shuffled, tracks), true));
        }} style={styles.shuffleButton}>
          <Icon name="shuffle" size={18} />
          <Text style={styles.shuffleLabel}>SHUFFLE</Text>
        </Touchable>
      </View>
      {!!contents?.unavailableCount && <Text style={styles.notice}>{contents.unavailableCount} {contents.unavailableCount === 1 ? "song is" : "songs are"} unavailable.</Text>}
      {loadError && <View style={styles.errorBox}>
        <Text accessibilityRole="alert" style={[styles.notice, styles.errorText]}>{loadError}</Text>
        <Touchable accessibilityRole="button" onPress={() => { setLoading(true); setReload(value => value + 1); }} style={styles.retry}><Text style={styles.retryLabel}>Retry</Text></Touchable>
      </View>}
      {loading && !contents && <ActivityIndicator color={colors.muted} style={styles.loading} />}
    </View>
  );

  return (
    <View style={styles.browser}>
      <FlatList
        data={tracks}
        keyExtractor={(track, index) => `${track.globalId}:${index}`}
        contentContainerStyle={[styles.listContent, { paddingBottom: bottomInset + 16 }]}
        scrollIndicatorInsets={{ bottom: bottomInset }}
        extraData={`${now?.globalId}:${playing}`}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={5}
        removeClippedSubviews={Platform.OS === "android"}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { haptic.tap(); setRefreshing(true); setReload(value => value + 1); }} tintColor="white" colors={["black"]} progressBackgroundColor="white" progressViewOffset={insets.top} />}
        ListHeaderComponent={header}
        ListEmptyComponent={!loading && !loadError ? <Text style={styles.empty}>No songs in this playlist yet.</Text> : undefined}
        renderItem={({ item, index }) => <TrackRow track={item} index={index} active={now?.globalId === item.globalId} playing={playing} bound={bound.get(item.globalId)} onPress={onPress} onMore={onMore} />}
      />
      <View pointerEvents="none" style={[styles.statusShade, { height: insets.top }]} />
      <ToastView toast={toast} bottom={bottomInset + 8} />
      {menu !== null && tracks[menu] && <Menu track={tracks[menu]} actions={menuActions(menu)} onClose={closeMenu} onVisibilityChange={onMenuVisibilityChange} />}
    </View>
  );
});

/** The shared queue, laid out like desktop's: what's playing, then what's next. */
export function QueueSheet({ view, onClose, onMenuVisibilityChange }: { view: SessionView | null; onClose: () => void; onMenuVisibilityChange?: (visible: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const now = currentTrack(view);
  const playing = !!view?.playing;
  const byId = useMemo(() => new Map(view?.queue.tracks?.map(track => [track.globalId, track])), [view?.queue.tracks]);
  const upcoming = view?.queue.upcoming ?? [];
  const latest = useRef(view);
  useLayoutEffect(() => { latest.current = view; });

  const perform = useCallback((work: () => Promise<void>) => {
    setError(null);
    void work().catch(reason => {
      haptic.error();
      setError(message(reason, "Couldn't update the queue."));
    });
  }, []);
  const edit = useCallback((index: number, action: "play" | "remove") => {
    const expected = latest.current?.queueRevision ?? 0;
    perform(() => changeQueue((queue, revision) => editUpcoming(queue, revision, expected, index, action), action === "play"));
  }, [perform]);
  const onPress = useCallback((index: number) => edit(index, "play"), [edit]);
  const onMore = useCallback((index: number) => setMenu(index), []);
  const toggle = useCallback(() => perform(() => command(latest.current?.playing ? "pause" : "play")), [perform]);
  const clear = () => {
    const expected = view?.queueRevision;
    perform(() => changeQueue((queue, revision) => {
      if (revision !== expected) throw new Error("The queue changed. Please try again.");
      return { ...queue, upcoming: [] };
    }));
  };
  const menuTrack = menu !== null ? byId.get(upcoming[menu]?.globalTrackId ?? "") : undefined;

  return <>
    <Sheet
      label="Queue"
      tall
      onClose={onClose}
      grip={<View style={styles.sheetHeading}>
        <View style={styles.sheetHeadingText}>
          <Text style={styles.sheetTitle}>Queue</Text>
          <Text style={styles.sheetSubtitle} numberOfLines={1}>{view?.output?.deviceName ?? "No output selected"}</Text>
        </View>
        {upcoming.length > 0 && <Touchable accessibilityRole="button" accessibilityLabel="Clear upcoming songs" haptic="warning" onPress={clear} style={styles.retry}><Text style={styles.clearLabel}>Clear</Text></Touchable>}
      </View>}
    >
      {() => <>
        {error && <Text accessibilityRole="alert" style={[styles.notice, styles.errorText]}>{error}</Text>}
        <FlatList
          style={styles.queueList}
          data={upcoming}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={5}
          keyExtractor={(item, index) => `${item.globalTrackId}:${index}`}
          extraData={byId}
          ListHeaderComponent={<View>
            <Text style={styles.sectionLabel}>Now Playing</Text>
            {now
              ? <TrackRow track={now} index={-1} active playing={playing} onPress={toggle} />
              : <Text style={styles.empty}>Nothing playing</Text>}
            <Text style={styles.sectionLabel}>Up Next{upcoming.length ? `  •  ${upcoming.length}` : ""}</Text>
          </View>}
          ListEmptyComponent={<Text style={styles.empty}>Nothing up next. Hold a song in MEGA to add it.</Text>}
          renderItem={({ item, index }) => {
            const track = byId.get(item.globalTrackId);
            return track
              ? <TrackRow track={track} index={index} active={false} playing={false} onPress={onPress} onMore={onMore} />
              : <Text style={styles.empty}>Unavailable song</Text>;
          }}
        />
      </>}
    </Sheet>
    {menu !== null && menuTrack && <Menu track={menuTrack} onClose={() => setMenu(null)} onVisibilityChange={onMenuVisibilityChange} actions={[
      { label: "Play from Here", icon: "skip", run: () => edit(menu, "play") },
      { label: "Remove from Queue", icon: "remove", run: () => edit(menu, "remove") },
    ]} />}
  </>;
}

const styles = StyleSheet.create({
  browser: { flex: 1, backgroundColor: colors.black },
  listContent: { paddingHorizontal: 12 },
  statusShade: { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: colors.black, opacity: 0.85 },
  hero: { flexDirection: "row", gap: 18, alignItems: "flex-end", paddingHorizontal: 8, paddingBottom: 22 },
  mosaic: { width: 132, height: 132, flexDirection: "row", flexWrap: "wrap", overflow: "hidden", borderRadius: 12, borderCurve: "continuous", backgroundColor: "#141414" },
  tile: { width: "50%", height: "50%" },
  heroText: { flex: 1, gap: 8, paddingBottom: 4 },
  title: { color: "white", fontFamily: fonts.serif, fontSize: 44, lineHeight: 50, fontWeight: "500" },
  summary: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 12 },
  playActions: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, marginBottom: 14 },
  playButton: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: "white", borderRadius: 100, height: 46 },
  shuffleButton: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, borderColor: "white", borderWidth: 1, borderRadius: 100, height: 46 },
  playLabel: { color: "black", fontFamily: fonts.sans, fontWeight: "600", fontSize: 15 },
  shuffleLabel: { color: "white", fontFamily: fonts.sans, fontWeight: "600", fontSize: 15 },
  loading: { paddingVertical: 32 },
  trackRow: { flexDirection: "row", alignItems: "center", gap: 12, height: 64, paddingLeft: 8, borderRadius: 12, borderCurve: "continuous", overflow: "hidden" },
  first: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  middle: { borderRadius: 0 },
  last: { borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  trackText: { flex: 1, gap: 4 },
  trackName: { color: "rgba(255, 255, 255, 0.9)", fontFamily: fonts.sans, fontSize: 15 },
  activeName: { color: "white", fontWeight: "700" },
  trackArtist: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  duration: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, fontVariant: ["tabular-nums"] },
  more: { width: 40, height: 48, alignItems: "center", justifyContent: "center" },
  moreSpacer: { width: 16 },
  notice: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, flexShrink: 1, paddingHorizontal: 8, paddingVertical: 6 },
  errorText: { color: colors.error },
  empty: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, paddingVertical: 24, paddingHorizontal: 8 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8 },
  retry: { minHeight: 44, justifyContent: "center", paddingHorizontal: 10 },
  retryLabel: { color: "white", fontFamily: fonts.sans, fontWeight: "600", fontSize: 14 },
  toast: { position: "absolute", alignSelf: "center", backgroundColor: colors.raised, borderColor: "#2f2f2f", borderWidth: StyleSheet.hairlineWidth, borderRadius: 100, paddingHorizontal: 18, paddingVertical: 10 },
  toastText: { color: "white", fontFamily: fonts.sans, fontSize: 13, fontWeight: "600" },
  sheetHeading: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 8 },
  sheetHeadingText: { flex: 1, gap: 2 },
  sheetTitle: { color: "white", fontFamily: fonts.serif, fontSize: 32, fontWeight: "500" },
  sheetSubtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12 },
  clearLabel: { color: colors.secondary, fontFamily: fonts.sans, fontWeight: "600", fontSize: 14 },
  queueList: { flex: 1 },
  // .queueSectionTitle in desktop/src/components/Queue.css.
  sectionLabel: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 12, fontWeight: "600", letterSpacing: 0.7, textTransform: "uppercase", paddingHorizontal: 8, paddingTop: 18, paddingBottom: 6 },
});
