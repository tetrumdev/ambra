import { useLayoutEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { GestureDetector, usePanGesture, useTapGesture, useExclusiveGestures } from "react-native-gesture-handler";
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { colors, fonts, glass, haptic, rubberBand, springs, textSize } from "../theme";

const HEIGHT = 46;
const INSET = 4;

/**
 * The tabs as words on a bar, with a lens behind the chosen one. The lens follows the pages as
 * they're swiped and stretches toward where it's going, like a drop of liquid pulled along.
 * Drag along the bar to scrub through tabs (a tick at each); tap one to jump; tap the chosen
 * one again to go back to its first page.
 */
export function TabBar({ labels, index, page, onSelect, onReselect }: {
  labels: string[];
  index: number;
  page: SharedValue<number>;
  onSelect(index: number): void;
  onReselect(): void;
}) {
  const [width, setWidth] = useState(1);
  const segment = width / labels.length;
  const pressed = useSharedValue(0);
  const scrub = useRef({ slot: index });
  const latest = useRef({ index, segment, onSelect, onReselect });
  useLayoutEffect(() => { latest.current = { index, segment, onSelect, onReselect }; });

  const slotAt = (x: number) => Math.min(labels.length - 1, Math.max(0, Math.floor(x / latest.current.segment)));
  const tap = useTapGesture({
    runOnJS: true,
    maxDuration: 400,
    onBegin: () => pressed.set(withSpring(1, springs.snappy)),
    onActivate: event => {
      const slot = slotAt(event.x);
      if (slot === latest.current.index) { haptic.tap(); latest.current.onReselect(); return; }
      haptic.tick();
      page.set(withSpring(slot, springs.settle));
      latest.current.onSelect(slot);
    },
    onFinalize: () => pressed.set(withSpring(0, springs.release)),
  });
  const pan = usePanGesture({
    runOnJS: true,
    activeOffsetX: [-6, 6],
    onBegin: () => pressed.set(withSpring(1, springs.snappy)),
    onActivate: () => { scrub.current.slot = latest.current.index; haptic.soft(); },
    onUpdate: event => {
      const { segment: size } = latest.current;
      const raw = event.x / size - 0.5;
      const last = labels.length - 1;
      page.set(raw < 0 ? rubberBand(raw * size, size) / size : raw > last ? last + rubberBand((raw - last) * size, size) / size : raw);
      const slot = slotAt(event.x);
      if (slot !== scrub.current.slot) { scrub.current.slot = slot; haptic.tick(); }
    },
    onDeactivate: event => {
      const slot = scrub.current.slot;
      page.set(withSpring(slot, { ...springs.settle, velocity: event.velocityX / latest.current.segment }));
      if (slot !== latest.current.index) latest.current.onSelect(slot);
    },
    onFinalize: () => pressed.set(withSpring(0, springs.release)),
  });
  const gesture = useExclusiveGestures(pan, tap);

  const lensStyle = useAnimatedStyle(() => {
    const value = page.get();
    const nearest = Math.round(value);
    const between = Math.abs(value - nearest);
    // Stretched mid-move, squeezed thinner as it stretches; swollen a little under a finger.
    const stretch = 1 + between * 0.9;
    const squeeze = 1 - between * 0.28;
    const grow = 1 + pressed.get() * 0.06;
    return {
      width: (segment - INSET * 2) * stretch * grow,
      height: (HEIGHT - INSET * 2) * squeeze * grow,
      transform: [{ translateX: value * segment + INSET - (segment - INSET * 2) * (stretch * grow - 1) / 2 }, { translateY: (HEIGHT - INSET * 2) * (1 - squeeze * grow) / 2 }],
    };
  });
  const barStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 + pressed.get() * 0.02 }] }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View collapsable={false} accessibilityRole="tablist" onLayout={event => setWidth(event.nativeEvent.layout.width)} style={[styles.bar, barStyle]}>
        <Animated.View pointerEvents="none" style={[styles.lens, lensStyle]} />
        {labels.map((label, at) => <Label key={label} label={label} at={at} page={page} selected={at === index} />)}
      </Animated.View>
    </GestureDetector>
  );
}

function Label({ label, at, page, selected }: { label: string; at: number; page: SharedValue<number>; selected: boolean }) {
  const style = useAnimatedStyle(() => {
    const near = Math.max(0, 1 - Math.abs(page.get() - at));
    return { color: interpolateColor(near, [0, 1], [colors.muted, colors.text]), transform: [{ scale: 1 + near * 0.04 }] };
  });
  return (
    <View accessible accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }} style={styles.slot}>
      <Animated.Text style={[styles.label, selected && styles.selected, style]}>{label}</Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { height: HEIGHT, flexDirection: "row", borderRadius: HEIGHT / 2, borderCurve: "continuous", backgroundColor: glass.dock, borderWidth: StyleSheet.hairlineWidth, borderColor: glass.border, overflow: "hidden" },
  lens: { position: "absolute", left: 0, top: INSET, borderRadius: HEIGHT, borderCurve: "continuous", backgroundColor: glass.lens },
  slot: { flex: 1, alignItems: "center", justifyContent: "center" },
  label: { fontFamily: fonts.sans, fontSize: textSize.small, fontWeight: "500" },
  selected: { fontWeight: "600" },
});
