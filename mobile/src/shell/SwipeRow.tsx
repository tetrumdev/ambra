import { useRef, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Icon, type IconName } from "../Icons";
import { colors, fonts, haptic, rubberBand, springs } from "../theme";
import { usePageGesture } from "./gestures";

export type SwipeAction = { icon: IconName; label: string; run: () => void; destructive?: boolean };

/** How far a row travels before letting go acts. */
const ARM = 84;
const REACH = 150;

/**
 * A row you swipe to act on, like Mail: drag right for `start`, left for `end`. The action's
 * icon grows out from the edge as the row moves; past the point of no return it pops and the
 * phone ticks, so you know letting go will do it. Pull back before releasing to change your mind.
 */
export function SwipeRow({ start, end, children, enabled = true }: {
  /** Revealed when swiping right. */
  start?: SwipeAction;
  /** Revealed when swiping left. */
  end?: SwipeAction;
  children: ReactNode;
  enabled?: boolean;
}) {
  const page = usePageGesture();
  const x = useSharedValue(0);
  const armed = useSharedValue(0);
  const state = useRef<{ armed: SwipeAction | null }>({ armed: null });
  const pan = usePanGesture({
    runOnJS: true,
    enabled: enabled && !!(start || end),
    activeOffsetX: [-14, 14],
    failOffsetY: [-10, 10],
    block: page ?? undefined,
    onUpdate: event => {
      const raw = event.translationX;
      const action = raw > 0 ? start : end;
      // Without an action that way, the row only gives a little.
      const travel = !action ? rubberBand(raw, 40) : Math.abs(raw) <= ARM ? raw : Math.sign(raw) * (ARM + rubberBand(Math.abs(raw) - ARM, REACH - ARM));
      x.set(travel);
      const next = action && Math.abs(raw) > ARM ? action : null;
      if (next !== state.current.armed) {
        state.current.armed = next;
        armed.set(withSpring(next ? 1 : 0, springs.bouncy));
        if (next) haptic.firm(); else haptic.tick();
      }
    },
    onDeactivate: event => {
      const action = state.current.armed;
      state.current.armed = null;
      armed.set(withSpring(0, springs.snappy));
      x.set(withSpring(0, { ...springs.release, velocity: event.velocityX }));
      if (action && !event.canceled) action.run();
    },
    onFinalize: () => {
      if (state.current.armed) { state.current.armed = null; armed.set(withSpring(0, springs.snappy)); }
      x.set(withSpring(0, springs.release));
    },
  });

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  const startStyle = useAnimatedStyle(() => {
    const shown = Math.max(0, x.get());
    return {
      opacity: interpolate(shown, [0, 28, ARM], [0, 0.6, 1], "clamp"),
      transform: [{ translateX: Math.min(0, shown - ARM) * 0.35 }, { scale: interpolate(shown, [0, ARM], [0.5, 1], "clamp") + armed.get() * 0.22 }],
    };
  });
  const endStyle = useAnimatedStyle(() => {
    const shown = Math.max(0, -x.get());
    return {
      opacity: interpolate(shown, [0, 28, ARM], [0, 0.6, 1], "clamp"),
      transform: [{ translateX: -Math.min(0, shown - ARM) * 0.35 }, { scale: interpolate(shown, [0, ARM], [0.5, 1], "clamp") + armed.get() * 0.22 }],
    };
  });
  const startWash = useAnimatedStyle(() => ({ opacity: x.get() > 0 ? 0.25 + armed.get() * 0.75 : 0 }));
  const endWash = useAnimatedStyle(() => ({ opacity: x.get() < 0 ? 0.25 + armed.get() * 0.75 : 0 }));

  if (!start && !end) return <>{children}</>;
  return (
    <GestureDetector gesture={pan}>
      <View collapsable={false} style={styles.frame}>
        {start && <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.wash, start.destructive && styles.destructive, startWash]} />}
        {end && <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.wash, end.destructive && styles.destructive, endWash]} />}
        {start && <Animated.View pointerEvents="none" style={[styles.action, styles.start, startStyle]}>
          <Icon name={start.icon} size={20} color={start.destructive ? colors.error : colors.accent} />
          <Text style={[styles.label, start.destructive && styles.destructiveLabel]}>{start.label}</Text>
        </Animated.View>}
        {end && <Animated.View pointerEvents="none" style={[styles.action, styles.end, endStyle]}>
          <Icon name={end.icon} size={20} color={end.destructive ? colors.error : colors.accent} />
          <Text style={[styles.label, end.destructive && styles.destructiveLabel]}>{end.label}</Text>
        </Animated.View>}
        <Animated.View style={[styles.row, rowStyle]}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: "hidden", borderRadius: 12, borderCurve: "continuous" },
  // Deep amber on black, like desktop's selection; red for removing.
  wash: { backgroundColor: "#1d1303" },
  destructive: { backgroundColor: "#260a0a" },
  row: { backgroundColor: colors.black },
  action: { position: "absolute", top: 0, bottom: 0, width: ARM, alignItems: "center", justifyContent: "center", gap: 3 },
  start: { left: 0 },
  end: { right: 0 },
  label: { color: colors.accent, fontFamily: fonts.sans, fontSize: 10, fontWeight: "600" },
  destructiveLabel: { color: colors.error },
});
