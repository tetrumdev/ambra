import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { coverWithSheet, previewUncover } from "./shell/chrome";
import { colors, haptic, motion, radius, rubberBand, space, springs } from "./theme";

const fall = { duration: motion.sheetOut, easing: Easing.in(Easing.quad) };
/** Black below the sheet, so pulling it up past its height never shows a gap. */
const OVERDRAW = 240;

/**
 * A black sheet that rises over everything while the app behind it recedes. It follows a drag
 * on its grip: down it travels with the finger and drops away when flicked or pulled far enough;
 * up it stretches against growing resistance and springs back. Children get `close` so a
 * choice can dismiss it in the same motion.
 */
export function Sheet({ label, onClose, grip, children, tall = false, dragAnywhere = false }: {
  label: string;
  onClose: () => void;
  /** Header content beside the handle, also a place to drag the sheet from. */
  grip?: ReactNode;
  children: (close: () => void) => ReactNode;
  /** Fixed near full height, for lists. */
  tall?: boolean;
  /** The whole sheet is a grip, for short sheets with nothing to scroll. */
  dragAnywhere?: boolean;
  /** Accepted for older callers; every sheet now looks the same. */
  variant?: "sheet" | "menu";
}) {
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const height = useSharedValue(screenHeight);
  const shown = useSharedValue(0);
  const drag = useSharedValue(0);
  const closing = useRef(false);
  const passed = useRef(false);
  const uncover = useRef<() => void>(() => {});

  useEffect(() => {
    uncover.current = coverWithSheet();
    shown.set(withSpring(1, motion.sheetIn));
    return () => { uncover.current(); cancelAnimation(shown); cancelAnimation(drag); };
  }, [shown, drag]);
  const finish = useCallback(() => { uncover.current(); onClose(); }, [onClose]);
  const close = useCallback((velocity = 0) => {
    if (closing.current) return;
    closing.current = true;
    uncover.current();
    const remaining = Math.max(1, height.get() - drag.get());
    // A flick keeps its speed on the way out; a tap or Back falls away at the usual pace.
    const duration = velocity > 0 ? Math.min(motion.sheetOut, Math.max(110, remaining / velocity * 1000)) : motion.sheetOut;
    shown.set(withTiming(0, { ...fall, duration, easing: velocity > 0 ? Easing.out(Easing.quad) : fall.easing }, done => { if (done) scheduleOnRN(finish); }));
  }, [height, drag, shown, finish]);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => { close(); return true; });
    return () => back.remove();
  }, [close]);

  const threshold = () => Math.min(140, height.get() * 0.3);
  const pan = usePanGesture({
    runOnJS: true,
    activeOffsetY: [-6, 6],
    failOffsetX: [-24, 24],
    onUpdate: event => {
      const y = event.translationY;
      drag.set(y >= 0 ? y : rubberBand(y, 120));
      previewUncover(Math.max(0, y) / Math.max(1, height.get()));
      const past = y > threshold();
      if (past !== passed.current) {
        passed.current = past;
        haptic.tick();
      }
    },
    onDeactivate: event => {
      passed.current = false;
      const flicked = event.translationY > 20 && event.velocityY > 650;
      if (!event.canceled && !closing.current && (event.translationY > threshold() || flicked)) {
        close(Math.max(event.velocityY, 0));
      } else {
        previewUncover(0);
        drag.set(withSpring(0, { ...springs.release, velocity: event.velocityY }));
      }
    },
    onFinalize: event => {
      if (event.canceled) { previewUncover(0); drag.set(withSpring(0, springs.release)); }
    },
  });

  // Dragged away, the sheet travels from where the finger left it to fully hidden.
  const sheetStyle = useAnimatedStyle(() => {
    const pull = drag.get();
    return {
      transform: [
        { translateY: (height.get() + OVERDRAW) * (1 - shown.get()) + pull * shown.get() },
        // Pulled up past its height, it swells a touch, as if stretched.
        { scaleX: pull < 0 ? 1 - pull / 2400 : 1 },
      ],
    };
  });
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: shown.get() * (1 - Math.min(1, Math.max(0, drag.get()) / Math.max(1, height.get()))),
  }));

  // `close` only runs from events; the compiler can't tell that a render-prop won't call it now.
  // eslint-disable-next-line react-hooks/refs
  const content = children(close);
  const maxHeight = screenHeight - insets.top - space.lg;
  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={`Close ${label}`} onPress={() => close()} />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={label}
        onAccessibilityEscape={() => close()}
        onLayout={event => height.set(event.nativeEvent.layout.height - OVERDRAW)}
        style={[styles.sheet, tall ? { height: maxHeight + OVERDRAW } : { maxHeight: maxHeight + OVERDRAW }, { paddingBottom: insets.bottom + space.md + OVERDRAW, marginBottom: -OVERDRAW }, sheetStyle]}
      >
        {dragAnywhere
          ? <GestureDetector gesture={pan}><View collapsable={false}><View style={styles.handle} />{grip}{content}</View></GestureDetector>
          : <>
            <GestureDetector gesture={pan}><View collapsable={false} style={styles.grip}><View style={styles.handle} />{grip}</View></GestureDetector>
            {content}
          </>}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0, 0, 0, 0.45)" },
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
  grip: { paddingBottom: 2 },
  handle: { width: 38, height: 5, borderRadius: 3, backgroundColor: "#3a3a3a", alignSelf: "center", marginTop: 8, marginBottom: 8 },
});
