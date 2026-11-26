import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Icon } from "../Icons";
import { haptic, rubberBand, springs } from "../theme";

const HEIGHT = 30;

/**
 * A volume bar you squeeze: it swells under the finger and moves by how far the finger travels
 * (so touching it never jumps the level). Pulled past either end it stretches and the phone
 * bumps; it springs back on release.
 */
export function VolumeSlider({ value, disabled = false, label, onChange }: {
  value: number;
  disabled?: boolean;
  label: string;
  /** Called as the level moves (0 to 100). */
  onChange(value: number): void;
}) {
  const [width, setWidth] = useState(1);
  const level = useSharedValue(value / 100);
  const over = useSharedValue(0);
  const held = useSharedValue(0);
  const start = useRef(0);
  const holding = useRef(false);
  const atEnd = useRef<"low" | "high" | null>(null);
  const lastSent = useRef(value);
  useEffect(() => { if (!holding.current) level.set(withSpring(value / 100, springs.snappy)); }, [value, level]);

  const pan = usePanGesture({
    runOnJS: true,
    enabled: !disabled,
    activeOffsetX: [-4, 4],
    failOffsetY: [-14, 14],
    onBegin: () => { held.set(withSpring(1, springs.snappy)); },
    onActivate: () => { holding.current = true; start.current = level.get(); haptic.soft(); },
    onUpdate: event => {
      const raw = start.current + event.translationX / width;
      const clamped = Math.min(1, Math.max(0, raw));
      level.set(clamped);
      over.set(raw < 0 ? rubberBand(raw * width, 24) : raw > 1 ? rubberBand((raw - 1) * width, 24) : 0);
      const end = clamped <= 0 ? "low" : clamped >= 1 ? "high" : null;
      if (end !== atEnd.current) { atEnd.current = end; if (end) haptic.firm(); }
      const next = Math.round(clamped * 100);
      if (next !== lastSent.current) { lastSent.current = next; onChange(next); }
    },
    onFinalize: () => {
      holding.current = false;
      atEnd.current = null;
      held.set(withSpring(0, springs.release));
      over.set(withSpring(0, springs.release));
    },
  });

  const trackStyle = useAnimatedStyle(() => {
    const stretch = over.get();
    return {
      transform: [
        { translateX: stretch * 0.5 },
        { scaleX: 1 + Math.abs(stretch) / Math.max(1, width) },
        // Squeezed thinner as it stretches, thicker while held.
        { scaleY: (1 + held.get() * 0.35) * (1 - Math.min(0.3, Math.abs(stretch) / 60)) },
      ],
    };
  });
  // Rounded, so a value springing toward 0 never prints as an exponent like "1e-9%".
  // A transform, not a width, so dragging never lays the sheet out again.
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: level.get() }] }));
  return (
    <GestureDetector gesture={pan}>
      <View collapsable={false} accessible accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: Math.round(value) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={event => onChange(Math.min(100, Math.max(0, value + (event.nativeEvent.actionName === "increment" ? 10 : -10))))}
        onLayout={event => setWidth(Math.max(1, event.nativeEvent.layout.width))}
        style={[styles.frame, disabled && styles.disabled]}>
        <Animated.View style={[styles.track, trackStyle]}>
          <Animated.View style={[styles.fill, fillStyle]} />
          <View pointerEvents="none" style={styles.icon}><Icon name={value <= 0 ? "volumeMuted" : value < 50 ? "volumeMid" : "output"} size={13} color="#6a6a6a" /></View>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  frame: { height: 44, justifyContent: "center" },
  disabled: { opacity: 0.4 },
  track: { height: HEIGHT, borderRadius: HEIGHT / 2, overflow: "hidden", backgroundColor: "#1a1a1a", borderCurve: "continuous" },
  fill: { width: "100%", height: "100%", transformOrigin: "left", backgroundColor: "rgba(255, 255, 255, 0.92)" },
  icon: { position: "absolute", left: 10, top: 0, bottom: 0, justifyContent: "center" },
});
