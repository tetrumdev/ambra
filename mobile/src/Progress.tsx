import { colors } from "./theme";
import * as Haptics from "expo-haptics";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};

const grow = { damping: 24, stiffness: 260, mass: 0.8 };
const HEIGHT = 7;
const HELD_HEIGHT = 14;
/** How far past the margins the bar reaches while held. */
const HELD_REACH = 6;

/**
 * Scrubs like Apple Music: holding grows the bar, and the playhead moves by how far the thumb
 * travels rather than jumping to where it landed, so a tap never loses your place.
 */
export function Progress({
  position,
  duration,
  revision,
  disabled,
  onSeek,
}: {
  position: number;
  duration: number;
  /** The session's revision; once it moves past a seek, the reported position takes over again. */
  revision: number;
  disabled: boolean;
  onSeek: (seconds: number) => void;
}) {
  const width = useRef(1);
  const drag = useRef({ start: 0, value: 0, moved: false, edge: 0 });
  const texture = useRef({ x: 0, at: 0 });
  const [scrub, setScrub] = useState<number | null>(null);
  const [showRemaining, setShowRemaining] = useState(true);
  // After letting go, the bar stays where it was dropped until the server confirms the seek.
  const [held, setHeld] = useState<{
    fraction: number;
    revision: number;
  } | null>(null);

  const reported = duration > 0 ? Math.min(1, position / duration) : 0;
  const fraction =
    scrub ?? (held?.revision === revision ? held.fraction : null) ?? reported;
  const latest = useRef({ fraction, duration, revision, onSeek });
  useLayoutEffect(() => {
    latest.current = { fraction, duration, revision, onSeek };
  });

  const pressed = useSharedValue(0);
  const fill = useSharedValue(fraction);
  const scrubbing = scrub !== null;
  useEffect(() => {
    // Follows a finger exactly; otherwise eases over the gap between position reports.
    fill.set(scrubbing ? fraction : withTiming(fraction, { duration: 250 }));
  }, [fraction, scrubbing, fill]);

  const pan = usePanGesture({
    enabled: !disabled && duration > 0,
    minDistance: 0,
    runOnJS: true,
    onBegin: () => {
      drag.current = {
        start: latest.current.fraction,
        value: latest.current.fraction,
        moved: false,
        edge: 0,
      };
      pressed.set(withSpring(1, grow));
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
    },
    onUpdate: (event) => {
      const raw = drag.current.start + event.translationX / width.current;
      const next = Math.min(1, Math.max(0, raw));
      if (Math.abs(event.translationX) > 2) drag.current.moved = true;
      // A fine, steady texture while the playhead moves, like a gentle vibration under the
      // thumb; it stops as soon as the thumb does. (Expo's haptics have no continuous effect.)
      const now = Date.now();
      if (Math.abs(event.absoluteX - texture.current.x) >= 2.5 && now - texture.current.at >= 22) {
        texture.current = { x: event.absoluteX, at: now };
        void Haptics.selectionAsync();
      }
      // A firmer tap at either end, once per arrival.
      const edge = raw <= 0 ? -1 : raw >= 1 ? 1 : 0;
      if (edge !== 0 && edge !== drag.current.edge)
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
      drag.current.edge = edge;
      drag.current.value = next;
      if (drag.current.moved) setScrub(next);
    },
    onFinalize: (event) => {
      pressed.set(withSpring(0, grow));
      setScrub(null);
      if (!drag.current.moved || event.canceled) return;
      const { duration, revision, onSeek } = latest.current;
      setHeld({ fraction: drag.current.value, revision });
      onSeek(drag.current.value * duration);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
  });

  const barStyle = useAnimatedStyle(() => ({
    height: HEIGHT + (HELD_HEIGHT - HEIGHT) * pressed.value,
    borderRadius: (HEIGHT + (HELD_HEIGHT - HEIGHT) * pressed.value) / 2,
    marginHorizontal: -HELD_REACH * pressed.value,
    backgroundColor: `rgba(255, 255, 255, ${Math.round(350 + 150 * pressed.value) / 1000})`,
  }));
  // A transform, not a width: it moves every frame while playing, and a width would lay the
  // player out again each time.
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));
  const timesStyle = useAnimatedStyle(() => ({
    opacity: 0.75 + 0.25 * pressed.value,
    transform: [{ translateY: 4 * pressed.value }],
  }));

  const shown = fraction * duration;
  return (
    <View>
      <GestureDetector gesture={pan}>
        <View
          style={styles.hit}
          onLayout={(event) => {
            width.current = Math.max(1, event.nativeEvent.layout.width);
          }}
        >
          <View style={styles.barSlot}>
            <Animated.View style={[styles.bar, barStyle]}>
              <Animated.View style={[styles.fill, fillStyle]} />
            </Animated.View>
          </View>
        </View>
      </GestureDetector>
      <Animated.View style={[styles.times, timesStyle]}>
        <Text style={styles.time}>{clock(shown)}</Text>
        <Pressable
          onPress={() => {
            setShowRemaining(current => !current);
            void Haptics.selectionAsync();
          }}
          disabled={disabled}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={showRemaining ? "Show total song length" : "Show time remaining"}
          accessibilityValue={{ text: showRemaining ? `${clock(duration - shown)} remaining` : `${clock(duration)} total` }}
        >
          <Text style={styles.time}>{showRemaining ? `-${clock(duration - shown)}` : clock(duration)}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Taller than the bar, so a thumb catches it without aiming.
  hit: { paddingVertical: 14, marginVertical: -14 },
  barSlot: { height: HELD_HEIGHT, justifyContent: "center" },
  bar: { overflow: "hidden" },
  fill: { width: "100%", height: "100%", transformOrigin: "left", backgroundColor: colors.text },
  times: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
  },
  time: {
    color: colors.text,
    fontFamily: "Stack Sans Text",
    fontSize: 11,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
  },
});
