import type { ReactNode } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { PRESSED_ALPHA, haptic as feedback } from "./theme";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const release = { damping: 14, stiffness: 380, mass: 0.6 };
/** Long enough that a resting thumb doesn't open menus, short enough to feel deliberate. */
export const HOLD_MS = 380;

type Props = Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  /** How far it sinks under a finger. */
  scale?: number;
  /** Lights up under a finger, for rows. */
  highlight?: boolean;
  haptic?: keyof typeof feedback | null;
  /** Buttons answer on touch; rows wait for the tap, so scrolling a list never buzzes. */
  hapticOnPressIn?: boolean;
};

/** Everything tappable sinks, springs back and answers with a haptic; holding opens options. */
export function Touchable({ style, children, scale = 0.95, highlight = false, haptic = "tap", hapticOnPressIn = false, disabled, onPressIn, onPressOut, onPress, onLongPress, ...rest }: Props) {
  const down = useSharedValue(0);
  const animated = useAnimatedStyle(() => {
    const transform = [{ scale: 1 - (1 - scale) * down.value }];
    return highlight ? { transform, backgroundColor: `rgba(255, 255, 255, ${PRESSED_ALPHA * down.value})` } : { transform };
  });
  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      delayLongPress={HOLD_MS}
      onPressIn={event => {
        down.set(withTiming(1, { duration: 110 }));
        if (hapticOnPressIn && haptic) feedback[haptic]();
        onPressIn?.(event);
      }}
      onPressOut={event => {
        down.set(withSpring(0, release));
        onPressOut?.(event);
      }}
      onPress={onPress && (event => {
        if (!hapticOnPressIn && haptic) feedback[haptic]();
        onPress(event);
      })}
      onLongPress={onLongPress && (event => {
        feedback.hold();
        down.set(withSpring(0, release));
        onLongPress(event);
      })}
      style={[style, animated, disabled && { opacity: 0.35 }]}
    >
      {children}
    </AnimatedPressable>
  );
}
