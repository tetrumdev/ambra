import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { changeQueue, command, currentTrack, type PlaylistContents, type SessionView } from "./client";
import { editUpcoming } from "./queueModel";
import { openMenu } from "./shell/ContextMenu";
import { Sheet } from "./Sheet";
import { colors, fonts, haptic, radius, space, textSize } from "./theme";
import { Touchable, type Frame } from "./Touchable";
import { TrackRow, ROW_HEIGHT, type Bound } from "./TrackRow";
import { ReorderRow, moved, useReorder } from "./reorder";

export { TrackRow };
const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

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

/**
 * The shared queue, laid out like desktop's: what's playing, then what's next. Swipe a song
 * left to remove it, right to play it now; hold and drag to move it.
 */
export function QueueSheet({ view, onClose }: { view: SessionView | null; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
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
  const onMore = useCallback((index: number, frame: Frame) => {
    const track = byId.get(latest.current?.queue.upcoming[index]?.globalTrackId ?? "");
    if (!track) return;
    openMenu({ lifted: { frame, node: <TrackRow track={track} index={index} active={false} playing={false} onPress={() => {}} /> }, actions: [
      { label: "Play from Here", icon: "skip", run: () => edit(index, "play") },
      { label: "Remove from Queue", icon: "remove", destructive: true, run: () => edit(index, "remove") },
    ] });
  }, [byId, edit]);
  const toggle = useCallback(() => perform(() => command(latest.current?.playing ? "pause" : "play")), [perform]);
  const clear = () => {
    const expected = view?.queueRevision;
    perform(() => changeQueue((queue, revision) => {
      if (revision !== expected) throw new Error("The queue changed. Please try again.");
      return { ...queue, upcoming: [] };
    }));
  };
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

  return (
    <Sheet
      label="Queue"
      tall
      onClose={onClose}
      grip={<View style={styles.heading}>
        <View style={styles.headingText}>
          <Text style={styles.title}>Queue</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{view?.output?.deviceName ?? "No output selected"}</Text>
        </View>
        {upcoming.length > 0 && <Touchable accessibilityRole="button" accessibilityLabel="Clear upcoming songs" haptic="warning" scale={0.9} onPress={clear} style={styles.clear}><Text style={styles.clearLabel}>Clear</Text></Touchable>}
      </View>}
    >
      {() => <View style={styles.list} {...reorder.containerProps}>
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        <FlatList
          ref={list as never}
          scrollsToTop={false}
          {...reorder.listProps}
          style={styles.list}
          data={upcoming}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={5}
          keyExtractor={(item, index) => `${item.globalTrackId}:${index}`}
          extraData={byId}
          ListHeaderComponent={<View onLayout={event => reorder.onRowsLayout(event.nativeEvent.layout.height)}>
            <Text style={styles.section}>Now Playing</Text>
            {now
              ? <TrackRow track={now} index={-1} active playing={playing} onPress={toggle} />
              : <Text style={styles.empty}>Nothing playing</Text>}
            <Text style={styles.section}>Up Next{upcoming.length ? `  ·  ${upcoming.length}` : ""}</Text>
          </View>}
          ListEmptyComponent={<Text style={styles.empty}>Nothing up next</Text>}
          renderItem={({ item, index }) => {
            const track = byId.get(item.globalTrackId);
            return <ReorderRow index={index} reorder={reorder} onHold={onMore}>
              {track
                ? <TrackRow track={track} index={index} active={false} playing={false} onPress={onPress} onMenu={onMore}
                  swipeStart={{ icon: "play", label: "Play", run: () => edit(index, "play") }}
                  swipeEnd={{ icon: "remove", label: "Remove", destructive: true, run: () => edit(index, "remove") }} />
                : <Text style={[styles.empty, styles.unavailable]}>Unavailable song</Text>}
            </ReorderRow>;
          }}
        />
        {reorder.overlay}
      </View>}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  heading: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: 8, paddingTop: 2, paddingBottom: 8 },
  headingText: { flex: 1, gap: 2 },
  title: { color: colors.text, fontFamily: fonts.serif, fontSize: 32, fontWeight: "500" },
  subtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.caption },
  clear: { minHeight: 36, justifyContent: "center", paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  clearLabel: { color: colors.secondary, fontFamily: fonts.sans, fontWeight: "600", fontSize: textSize.detail },
  list: { flex: 1 },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: textSize.detail, lineHeight: 20, paddingHorizontal: 8, paddingVertical: 6 },
  empty: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.small, lineHeight: 20, paddingVertical: 24, paddingHorizontal: 8 },
  unavailable: { height: ROW_HEIGHT, paddingVertical: 0, lineHeight: ROW_HEIGHT },
  // .queueSectionTitle in desktop/src/components/Queue.css.
  section: { color: colors.secondary, fontFamily: fonts.sans, fontSize: textSize.caption, fontWeight: "600", letterSpacing: 0.7, textTransform: "uppercase", paddingHorizontal: 8, paddingTop: 18, paddingBottom: 6 },
});
