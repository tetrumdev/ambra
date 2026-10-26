import { useCallback, useEffect, type ReactNode } from "react";
import { BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { colors, haptic } from "./theme";

const rise = { damping: 32, stiffness: 340, mass: 1, overshootClamping: true };
const settle = { damping: 22, stiffness: 300, mass: 0.8 };
const fall = { duration: 200, easing: Easing.in(Easing.quad) };

/**
 * A black sheet that rises over everything, follows a drag on its grip and drops away when
 * flicked or dragged far enough. Children get `close` so a choice can dismiss it in the same motion.
 */
export function Sheet({ label, onClose, grip, children, tall = false, dragAnywhere = false }: {
  label: string;
  onClose: () => void;
  /** Header content beside the handle, also a place to drag the sheet from. */
  grip?: ReactNode;
  children: (close: () => void) => ReactNode;
  /** Fixed near full height, for lists. */
  tall?: boolean;
  /** The whole sheet is a grip, for short menus with nothing to scroll. */
  dragAnywhere?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const height = useSharedValue(screenHeight);
  const shown = useSharedValue(0);
  const drag = useSharedValue(0);
  const closing = useSharedValue(false);
  const passed = useSharedValue(false);

  useEffect(() => {
    shown.set(withSpring(1, rise));
    return () => { cancelAnimation(shown); cancelAnimation(drag); };
  }, [shown, drag]);
  const close = useCallback(() => {
    if (closing.get()) return;
    closing.set(true);
    shown.set(withTiming(0, fall, finished => { if (finished) scheduleOnRN(onClose); }));
  }, [closing, shown, onClose]);
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
        shown.set(withTiming(0, { duration: 180, easing: Easing.out(Easing.quad) }, finished => { if (finished) scheduleOnRN(onClose); }));
      } else drag.set(withSpring(0, settle));
    },
    onFinalize: event => {
      if (event.canceled) drag.set(withSpring(0, settle));
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
        style={[styles.sheet, tall ? { height: screenHeight - insets.top - 16 } : { maxHeight: screenHeight - insets.top - 16 }, { paddingBottom: insets.bottom + 12 }, sheetStyle]}
      >
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
  backdrop: { backgroundColor: "rgba(0, 0, 0, 0.7)" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.black,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderColor: "#2f2f2f",
    paddingHorizontal: 16,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: "#3a3a3a", alignSelf: "center", marginTop: 8, marginBottom: 6 },
});
