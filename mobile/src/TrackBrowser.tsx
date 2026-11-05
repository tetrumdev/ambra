import { LinearGradient } from "expo-linear-gradient";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { Artwork } from "./Artwork";
import { changeQueue, command, currentTrack, type PlaylistContents, type SessionView, type Track } from "./client";
import { Icon } from "./Icons";
import { Menu } from "./Menu";
import { editUpcoming } from "./queueModel";
import { Sheet } from "./Sheet";
import { colors, fonts, haptic } from "./theme";
import { Touchable } from "./Touchable";
import { ROW_HEIGHT, ReorderRow, moved, useReorder } from "./reorder";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

type Bound = "first" | "middle" | "last";
/** Where each song sits in the songs bound with it; a package with one playable song isn't shown. */
export function boundRows(contents: Pick<PlaylistContents, "playlist" | "tracks"> | null) {
  const rows = new Map<string, Bound>();
  const playable = new Set(contents?.tracks.map(track => track.globalId));
  for (const pack of contents?.playlist.packages ?? []) {
    const shown = pack.filter(id => playable.has(id));
    if (shown.length < 2) continue;
    shown.forEach((id, at) => rows.set(id, at === 0 ? "first" : at === shown.length - 1 ? "last" : "middle"));
  }
  return rows;
}

export const TrackRow = memo(function TrackRow({ track, index, active, playing, bound, downloaded, holdDrags = false, onPress, onMore, onHold }: {
  track: Track;
  index: number;
  active: boolean;
  playing: boolean;
  /** Bound songs read as one block, in desktop's amber (.libraryItem[data-package]). */
  bound?: Bound;
  /** Saved on this phone, shown with desktop's download glyph. */
  downloaded?: boolean;
  onPress: (index: number) => void;
  /** The ⋯ button: desktop's edit menu. */
  onMore?: (index: number) => void;
  /** Holding the row: desktop's playback menu; the edit menu when there's none. */
  onHold?: (index: number) => void;
  /** The hold belongs to a drag gesture around the row (`ReorderRow`), which opens the menu itself. */
  holdDrags?: boolean;
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
      onLongPress={!holdDrags && (onHold ?? onMore) ? () => (onHold ?? onMore)!(index) : undefined}
      style={[styles.trackRow, bound && styles[bound]]}
    >
      {bound && <LinearGradient pointerEvents="none" colors={["rgba(53, 32, 0, 0.5)", "transparent"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />}
      <Artwork track={track} />
      <View style={styles.trackText}>
        <Text numberOfLines={1} style={[styles.trackName, active && styles.activeName]}>{track.name}</Text>
        <Text numberOfLines={1} style={styles.trackArtist}>{track.artist}</Text>
      </View>
      {downloaded && <Icon name="download" size={11} color={colors.muted} />}
      {active ? <Icon name={playing ? "pause" : "play"} size={12} /> : <Text style={styles.duration}>{clock(track.durationSeconds)}</Text>}
      {onMore ? <Touchable accessibilityRole="button" accessibilityLabel={`Options for ${track.name}`} haptic="select" hitSlop={6} onPress={() => onMore(index)} style={styles.more}>
        <Icon name="more" rotation={90} size={16} color={colors.muted} />
      </Touchable> : <View style={styles.moreSpacer} />}
    </Touchable>
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
  // Hold an upcoming song, then drag it to its new place in the queue.
  const list = useRef<FlatList<unknown>>(null);
  const reorder = useReorder({
    list,
    count: upcoming.length,
    onMove: (from, to) => {
      const expected = latest.current?.queueRevision ?? 0;
      perform(() => changeQueue((queue, revision) => {
        if (revision !== expected) throw new Error("The queue changed on another device. Please try again.");
        return { ...queue, upcoming: moved(queue.upcoming, from, to) };
      }));
    },
    renderLifted: index => {
      const track = byId.get(upcoming[index]?.globalTrackId ?? "");
      return track ? <TrackRow track={track} index={index} active={false} playing={false} onPress={() => {}} /> : null;
    },
  });

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
      {() => <View style={styles.queueList} {...reorder.containerProps}>
        {error && <Text accessibilityRole="alert" style={[styles.notice, styles.errorText]}>{error}</Text>}
        <FlatList
          ref={list as never}
          {...reorder.listProps}
          style={styles.queueList}
          data={upcoming}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={5}
          keyExtractor={(item, index) => `${item.globalTrackId}:${index}`}
          extraData={byId}
          ListHeaderComponent={<View onLayout={event => reorder.onRowsLayout(event.nativeEvent.layout.height)}>
            <Text style={styles.sectionLabel}>Now Playing</Text>
            {now
              ? <TrackRow track={now} index={-1} active playing={playing} onPress={toggle} />
              : <Text style={styles.empty}>Nothing playing</Text>}
            <Text style={styles.sectionLabel}>Up Next{upcoming.length ? `  •  ${upcoming.length}` : ""}</Text>
          </View>}
          ListEmptyComponent={<Text style={styles.empty}>Nothing up next. Hold a song and choose Add to Queue.</Text>}
          renderItem={({ item, index }) => {
            const track = byId.get(item.globalTrackId);
            return <ReorderRow index={index} reorder={reorder} enabled onHold={onMore}>
              {track
                ? <TrackRow track={track} index={index} active={false} playing={false} holdDrags onPress={onPress} onMore={onMore} />
                : <Text style={[styles.empty, styles.unavailable]}>Unavailable song</Text>}
            </ReorderRow>;
          }}
        />
        {reorder.overlay}
      </View>}
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
  unavailable: { height: ROW_HEIGHT, paddingVertical: 0, lineHeight: ROW_HEIGHT },
  // .queueSectionTitle in desktop/src/components/Queue.css.
  sectionLabel: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 12, fontWeight: "600", letterSpacing: 0.7, textTransform: "uppercase", paddingHorizontal: 8, paddingTop: 18, paddingBottom: 6 },
});
