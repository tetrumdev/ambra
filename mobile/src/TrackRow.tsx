import { LinearGradient } from "expo-linear-gradient";
import { memo, useRef, type ComponentRef } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Artwork } from "./Artwork";
import type { Track } from "./client";
import { useDownloadMark } from "./downloads";
import { Icon } from "./Icons";
import { SwipeRow, type SwipeAction } from "./shell/SwipeRow";
import { colors, fonts, radius, space, textSize } from "./theme";
import { Touchable, type Frame } from "./Touchable";

export const ROW_HEIGHT = 64;
export type Bound = "first" | "middle" | "last";
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** An equalizer's three bars, standing still while paused. */
function NowPlaying({ playing }: { playing: boolean }) {
  return <View accessible={false} style={styles.bars}>
    {[0.55, 1, 0.75].map((height, index) => <View key={index} style={[styles.bar, { height: `${(playing ? height : 0.3) * 100}%` }]} />)}
  </View>;
}

/** Qobuz's mark before the artist: a check, gold for Hi-Res and white otherwise, or a spinner while it downloads. */
function DownloadMark({ id }: { id: string }) {
  const mark = useDownloadMark(id);
  if (!mark) return null;
  if (mark === "downloading") return <ActivityIndicator size="small" color={colors.muted} style={styles.downloading} accessibilityLabel="Downloading" />;
  return <View accessibilityLabel={mark === "hiRes" ? "Downloaded in Hi-Res" : "Downloaded"} style={[styles.mark, mark === "hiRes" && styles.hiRes]}>
    <Icon name="check" size={8} color={colors.black} />
  </View>;
}

/**
 * A song in a list. Tap plays it; swipe right plays it next, left adds it to the queue. Holding
 * it (see `ReorderRow`) or tapping ⋯ lifts it and opens its menu beside it.
 */
export const TrackRow = memo(function TrackRow({ track, index, active, playing, bound, detail, swipeStart, swipeEnd, onPress, onMenu }: {
  track: Track;
  index: number;
  active: boolean;
  playing: boolean;
  /** Bound songs read as one block, in desktop's amber (.libraryItem[data-package]). */
  bound?: Bound;
  /** A small note under the artist, like the song's service in search. */
  detail?: string;
  swipeStart?: SwipeAction;
  swipeEnd?: SwipeAction;
  onPress: (index: number) => void;
  /** Opens the song's menu beside the row, at `frame` on screen. */
  onMenu?: (index: number, frame: Frame) => void;
}) {
  const row = useRef<ComponentRef<typeof View>>(null);
  return (
    <SwipeRow start={swipeStart} end={swipeEnd}>
      <View ref={row} collapsable={false}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${active ? (playing ? "Pause" : "Resume") : "Play"} ${track.name}, ${track.artist}`}
        accessibilityHint={[swipeStart && `Swipe right to ${swipeStart.label.toLowerCase()}.`, swipeEnd && `Swipe left to ${swipeEnd.label.toLowerCase()}.`, onMenu && "Hold for more options."].filter(Boolean).join(" ") || undefined}
        accessibilityState={{ selected: active }}
        highlight
        scale={0.975}
        haptic="select"
        unstable_pressDelay={50}
        onPress={() => onPress(index)}
        style={[styles.row, bound && styles[bound]]}
      >
        {bound && <LinearGradient pointerEvents="none" colors={["rgba(53, 32, 0, 0.55)", "transparent"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />}
        <View>
          <Artwork track={track} />
          {active && <View style={styles.playingOverlay}><NowPlaying playing={playing} /></View>}
        </View>
        <View style={styles.text}>
          <Text numberOfLines={1} style={[styles.name, active && styles.activeName]}>{track.name}</Text>
          <View style={styles.byline}>
            <DownloadMark id={track.globalId} />
            <Text numberOfLines={1} style={styles.artist}>{detail ? `${track.artist}  ·  ${detail}` : track.artist}</Text>
          </View>
        </View>
        <Text style={styles.duration}>{clock(track.durationSeconds)}</Text>
        {onMenu ? <Touchable accessibilityRole="button" accessibilityLabel={`Options for ${track.name}`} haptic="hold" hitSlop={6} scale={0.8}
          onPress={() => row.current?.measureInWindow((x, y, width, height) => onMenu(index, { x, y, width, height }))} style={styles.more}>
          <Icon name="more" rotation={90} size={16} color={colors.muted} />
        </Touchable> : <View style={styles.moreSpacer} />}
      </Touchable>
      </View>
    </SwipeRow>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.md, height: ROW_HEIGHT, paddingLeft: 8, borderRadius: radius.md, borderCurve: "continuous", overflow: "hidden", backgroundColor: colors.black },
  first: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  middle: { borderRadius: 0 },
  last: { borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  playingOverlay: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, borderRadius: 6, backgroundColor: "rgba(0, 0, 0, 0.55)", alignItems: "center", justifyContent: "center" },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 14 },
  bar: { width: 3, borderRadius: 1.5, backgroundColor: colors.accent },
  text: { flex: 1, gap: space.xs },
  name: { color: "rgba(255, 255, 255, 0.92)", fontFamily: fonts.sans, fontSize: 15 },
  activeName: { color: colors.accent, fontWeight: "600" },
  byline: { flexDirection: "row", alignItems: "center", gap: 6 },
  artist: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.detail },
  mark: { width: 13, height: 13, borderRadius: 6.5, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  hiRes: { backgroundColor: "#dcc07f" },
  downloading: { width: 13, height: 13, transform: [{ scale: 0.6 }] },
  duration: { color: colors.faint, fontFamily: fonts.sans, fontSize: textSize.caption, fontVariant: ["tabular-nums"] },
  more: { width: 40, height: 48, alignItems: "center", justifyContent: "center" },
  moreSpacer: { width: 16 },
});
