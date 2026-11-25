import { useCallback, useEffect, type ReactNode } from "react";
import { BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { BlurView } from "expo-blur";
import { colors, haptic, motion, radius, space } from "./theme";

const fall = { duration: motion.sheetOut, easing: Easing.in(Easing.quad) };
const flick = { duration: motion.sheetFlick, easing: Easing.out(Easing.quad) };
const menuTiming = { duration: motion.settle.duration, easing: Easing.bezier(...motion.settle.curve) };

/**
 * A black sheet that rises over everything, follows a drag on its grip and drops away when
 * flicked or dragged far enough. Children get `close` so a choice can dismiss it in the same motion.
 */
export function Sheet({ label, onClose, grip, children, tall = false, dragAnywhere = false, variant = "sheet" }: {
  label: string;
  onClose: () => void;
  /** Header content beside the handle, also a place to drag the sheet from. */
  grip?: ReactNode;
  children: (close: () => void) => ReactNode;
  /** Fixed near full height, for lists. */
  tall?: boolean;
  /** The whole sheet is a grip, for short menus with nothing to scroll. */
  dragAnywhere?: boolean;
  variant?: "sheet" | "menu";
}) {
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const height = useSharedValue(screenHeight);
  const shown = useSharedValue(0);
  const drag = useSharedValue(0);
  const closing = useSharedValue(false);
  const passed = useSharedValue(false);
  const compactMenu = variant === "menu";

  useEffect(() => {
    shown.set(compactMenu ? withTiming(1, menuTiming) : withSpring(1, motion.sheetIn));
    return () => { cancelAnimation(shown); cancelAnimation(drag); };
  }, [compactMenu, shown, drag]);
  const close = useCallback(() => {
    if (closing.get()) return;
    closing.set(true);
    shown.set(withTiming(0, compactMenu ? menuTiming : fall, finished => { if (finished) scheduleOnRN(onClose); }));
  }, [closing, compactMenu, shown, onClose]);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => { close(); return true; });
    return () => back.remove();
  }, [close]);

  const pan = usePanGesture({
    runOnJS: true,
    activeOffsetY: [-8, 8],
    failOffsetX: [-24, 24],
    onUpdate: event => {
      // Resists being pulled up past its height; follows the finger down.
      const y = event.translationY;
      drag.set(y >= 0 ? y : -Math.sqrt(-y) * 2);
      const past = y > Math.min(120, height.get() * 0.3);
      if (past !== passed.get()) {
        passed.set(past);
        if (past) haptic.select();
      }
    },
    onDeactivate: event => {
      passed.set(false);
      if (!event.canceled && !closing.get() && (event.translationY > Math.min(120, height.get() * 0.3) || (event.translationY > 20 && event.velocityY > 700))) {
        closing.set(true);
        shown.set(withTiming(0, compactMenu ? menuTiming : flick, finished => { if (finished) scheduleOnRN(onClose); }));
      } else drag.set(withSpring(0, motion.sheetSettle));
    },
    onFinalize: event => {
      if (event.canceled) drag.set(withSpring(0, motion.sheetSettle));
    },
  });

  // Dragged away, the sheet travels from where the finger left it to fully hidden.
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: height.get() * (1 - shown.get()) + drag.get() * shown.get() }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: shown.get() * (1 - Math.min(1, Math.max(0, drag.get()) / Math.max(1, height.get()))),
  }));

  const content = children(close);
  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={`Close ${label}`} onPress={close} />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={label}
        onAccessibilityEscape={close}
        onLayout={event => height.set(event.nativeEvent.layout.height)}
        style={[styles.sheet, tall ? { height: screenHeight - insets.top - space.lg } : { maxHeight: screenHeight - insets.top - space.lg }, { paddingBottom: insets.bottom + space.md }, variant === "menu" && [styles.menu, { bottom: insets.bottom + space.md }], sheetStyle]}
      >
        {variant === "menu" && <BlurView pointerEvents="none" tint="dark" intensity={60} style={StyleSheet.absoluteFill} />}
        {dragAnywhere
          ? <GestureDetector gesture={pan}><View collapsable={false}><View style={styles.handle} />{grip}{content}</View></GestureDetector>
          : <>
            <GestureDetector gesture={pan}><View collapsable={false}><View style={styles.handle} />{grip}</View></GestureDetector>
            {content}
          </>}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: colors.scrim },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.black,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: "#3a3a3a", alignSelf: "center", marginTop: 8, marginBottom: 6 },
  menu: {
    left: space.lg,
    right: space.lg,
    borderRadius: radius.md,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    borderWidth: 1,
    borderBottomWidth: 1,
    backgroundColor: colors.menu,
    paddingHorizontal: 0,
    paddingBottom: space.xs,
    overflow: "hidden",
  },
});
