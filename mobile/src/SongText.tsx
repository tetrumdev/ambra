import { useLayoutEffect, useRef } from "react";
import type { StyleProp, TextStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, type AnimatedStyle } from "react-native-reanimated";
import { playerTiming, SONG_TRAVEL, type SkipDirection } from "./playerMotion";

/** Like the bigscreen song details, only a changed field arrives from the skip direction. */
export function SongText({ children, style, direction }: { children: string; style: StyleProp<AnimatedStyle<TextStyle>>; direction: SkipDirection }) {
  const shown = useRef(children);
  const progress = useSharedValue(1);
  const step = useSharedValue(1);
  useLayoutEffect(() => {
    if (shown.current === children) return;
    shown.current = children;
    step.set(direction());
    progress.set(0);
    progress.set(withTiming(1, playerTiming));
  }, [children, direction, progress, step]);
  const animation = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateX: step.value * SONG_TRAVEL * (1 - progress.value) }],
  }));
  return <Animated.Text style={[style, animation]} numberOfLines={1}>{children}</Animated.Text>;
}
