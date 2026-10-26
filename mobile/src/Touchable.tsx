import { useEffect, useMemo, type ReactNode } from "react";
import { Animated, Pressable, useAnimatedValue, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
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
  const down = useAnimatedValue(0);
  // Virtualized rows can disappear while a press spring is still running.
  useEffect(() => () => down.stopAnimation(), [down]);
  // Native Animated keeps press/recycle lifetimes out of the Worklets runtime.
  const animated = useMemo(() => ({
    transform: [{ scale: down.interpolate({ inputRange: [0, 1], outputRange: [1, scale] }) }],
    ...(highlight ? { backgroundColor: down.interpolate({ inputRange: [0, 1], outputRange: ["rgba(255, 255, 255, 0)", `rgba(255, 255, 255, ${PRESSED_ALPHA})`] }) } : {}),
  }), [down, scale, highlight]);
  return (
    <AnimatedPressable
      {...rest}
      collapsable={false}
      disabled={disabled}
      delayLongPress={HOLD_MS}
      onPressIn={event => {
        Animated.timing(down, { toValue: 1, duration: 110, useNativeDriver: true, isInteraction: false }).start();
        if (hapticOnPressIn && haptic) feedback[haptic]();
        onPressIn?.(event);
      }}
      onPressOut={event => {
        Animated.spring(down, { toValue: 0, ...release, useNativeDriver: true, isInteraction: false }).start();
        onPressOut?.(event);
      }}
      onPress={onPress && (event => {
        if (!hapticOnPressIn && haptic) feedback[haptic]();
        onPress(event);
      })}
      onLongPress={onLongPress && (event => {
        feedback.hold();
        Animated.spring(down, { toValue: 0, ...release, useNativeDriver: true, isInteraction: false }).start();
        onLongPress(event);
      })}
      style={[style, animated, disabled && { opacity: 0.35 }]}
    >
      {children}
    </AnimatedPressable>
  );
}
