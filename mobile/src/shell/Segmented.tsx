import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { colors, fonts, haptic, radius, springs, textSize } from "../theme";
import { Touchable } from "../Touchable";
import { usePageGesture } from "./gestures";

type Item<T extends string> = { value: T; label: string };

/**
 * A row of choices with a white pill behind the chosen one. Picking another sends the pill
 * there with a stretch: its leading edge leaves first and the trailing edge catches up.
 */
export function Segmented<T extends string>({ items, value, onChange, label }: { items: Item<T>[]; value: T; onChange(value: T): void; label: string }) {
  const page = usePageGesture();
  const [frames, setFrames] = useState<Record<string, { x: number; width: number }>>({});
  const left = useSharedValue(0);
  const right = useSharedValue(0);
  const ready = useRef(false);
  const frame = frames[value];
  useEffect(() => {
    if (!frame) return;
    const end = frame.x + frame.width;
    if (!ready.current) { ready.current = true; left.set(frame.x); right.set(end); return; }
    // The edge in the direction of travel moves first and faster.
    const forward = frame.x > left.get();
    left.set(withSpring(frame.x, forward ? springs.settle : springs.snappy));
    right.set(withSpring(end, forward ? springs.snappy : springs.settle));
  }, [frame, left, right]);
  const pill = useAnimatedStyle(() => ({ left: left.get(), width: Math.max(0, right.get() - left.get()) }));
  return (
    <ScrollView horizontal scrollsToTop={false} block={page ?? undefined} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <View>
        <Animated.View pointerEvents="none" style={[styles.pill, pill, !frame && styles.hidden]} />
        <View style={styles.items}>
          {items.map(item => {
            const on = item.value === value;
            return <Touchable key={item.value} accessibilityRole="radio" accessibilityState={{ checked: on }} haptic={null} scale={0.9}
              onPress={() => { if (!on) { haptic.tick(); onChange(item.value); } }}
              onLayout={event => { const { x, width } = event.nativeEvent.layout; setFrames(current => current[item.value]?.x === x && current[item.value]?.width === width ? current : { ...current, [item.value]: { x, width } }); }}
              style={styles.item}>
              <Text numberOfLines={1} style={[styles.text, on && styles.textOn]}>{item.label}</Text>
            </Touchable>;
          })}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 20, paddingVertical: 4 },
  items: { flexDirection: "row", gap: 6 },
  item: { minHeight: 36, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  pill: { position: "absolute", top: 0, bottom: 0, borderRadius: radius.pill, backgroundColor: colors.text },
  hidden: { opacity: 0 },
  text: { fontFamily: fonts.sans, fontSize: textSize.detail, fontWeight: "600", color: colors.muted },
  textOn: { color: colors.black },
});
