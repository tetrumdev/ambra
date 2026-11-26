import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle } from "react-native-svg";
import { useDownloads } from "./downloads";
import { Icon } from "./Icons";
import { colors, fonts, haptic } from "./theme";

/** The Dynamic Island's size on the phones that have one, in points. */
const ISLAND = { top: 11, width: 126, height: 37 };
const OPEN_WIDTH = 250;
const RING = 18;
const ease = { duration: 280, easing: Easing.out(Easing.cubic) };

/**
 * Downloads to this phone, shown as the Dynamic Island growing sideways (as Qobuz does): a
 * turning ring on the left, how many are done on the right, then a check when all are saved.
 * On a black screen the pill and the island read as one. Phones without an island get the
 * same pill under the status bar.
 */
export function DownloadIsland() {
  const { active } = useDownloads();
  const insets = useSafeAreaInsets();
  const island = insets.top >= 51;
  const [finished, setFinished] = useState(false);
  const [wasActive, setWasActive] = useState(false);
  // A download ending shows its check briefly (state adjusted while rendering, React's documented pattern).
  if (!!active !== wasActive) {
    setWasActive(!!active);
    setFinished(!active);
  }
  useEffect(() => {
    if (!finished) return;
    haptic.success();
    const timer = setTimeout(() => setFinished(false), 1600);
    return () => clearTimeout(timer);
  }, [finished]);
  const open = !!active || finished;

  const grow = useSharedValue(0);
  const turn = useSharedValue(0);
  useEffect(() => { grow.value = withTiming(open ? 1 : 0, ease); }, [open, grow]);
  useEffect(() => {
    if (!active) { cancelAnimation(turn); return; }
    turn.value = 0;
    turn.value = withRepeat(withTiming(360, { duration: 900, easing: Easing.linear }), -1);
  }, [active, turn]);
  const pill = useAnimatedStyle(() => ({
    width: ISLAND.width + (OPEN_WIDTH - ISLAND.width) * grow.value,
    opacity: island ? 1 : grow.value,
  }));
  const content = useAnimatedStyle(() => ({ opacity: Math.max(0, grow.value * 1.6 - 0.6) }));
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value}deg` }] }));

  const progress = active ? `${Math.min(active.done + 1, active.total)} of ${active.total}` : "Saved";
  return (
    <Animated.View pointerEvents="none" accessibilityLiveRegion="polite" accessibilityLabel={active ? `Downloading ${progress}` : finished ? "Downloads saved" : undefined}
      style={[styles.pill, { top: island ? ISLAND.top : insets.top + 4 }, pill]}>
      <Animated.View style={[styles.content, content]}>
        {active ? <Animated.View style={spin}>
          <Svg width={RING} height={RING}>
            <Circle cx={RING / 2} cy={RING / 2} r={RING / 2 - 1.5} stroke="rgba(255,255,255,0.18)" strokeWidth={2.5} fill="none" />
            <Circle cx={RING / 2} cy={RING / 2} r={RING / 2 - 1.5} stroke={colors.text} strokeWidth={2.5} fill="none" strokeLinecap="round"
              strokeDasharray={`${Math.PI * (RING - 3) * 0.3} ${Math.PI * (RING - 3)}`} />
          </Svg>
        </Animated.View> : <View style={styles.check}><Icon name="check" size={10} color={colors.black} /></View>}
        <Text style={styles.label}>{progress}</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: { position: "absolute", alignSelf: "center", height: ISLAND.height, borderRadius: ISLAND.height / 2, borderCurve: "continuous", backgroundColor: colors.black, overflow: "hidden", zIndex: 100 },
  content: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14 },
  check: { width: RING, height: RING, borderRadius: RING / 2, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  label: { color: colors.text, fontFamily: fonts.sans, fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
