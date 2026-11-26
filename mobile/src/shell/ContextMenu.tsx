import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { BlurView } from "expo-blur";
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { Artwork } from "../Artwork";
import type { Track } from "../client";
import { Icon, type IconName } from "../Icons";
import { colors, fonts, glass, haptic, radius, sizes, space, textSize } from "../theme";
import type { Anchor, Frame } from "../Touchable";

export type MenuAction = { label: string; icon: IconName; destructive?: boolean; disabled?: boolean; run: () => void; section?: boolean };
export type MenuRequest = {
  /** Where the finger was; the menu grows out of that point. Centered when missing. */
  anchor?: Anchor;
  /** A row lifted above the dimmed screen, with the menu beside it (a held song). */
  lifted?: { frame: Frame; node: ReactNode };
  track?: Track;
  title?: string;
  subtitle?: string;
  actions: MenuAction[];
};

let current: (MenuRequest & { id: number }) | null = null;
const listeners = new Set<() => void>();
const publish = (next: typeof current) => { current = next; for (const listener of listeners) listener(); };
let dismiss: (() => void) | null = null;

/** Opens desktop's compact glass menu at a touch or beside a lifted row, over everything (one at a time). */
export function openMenu(request: MenuRequest) {
  if (!request.actions.length) return;
  publish({ ...request, id: Date.now() });
}
/** Closes the open menu, as when a held row starts being dragged. */
export function closeMenu() { dismiss?.(); }
export const menuOpen = () => current !== null;
export function subscribeMenu(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

const WIDTH = 252;
const EDGE = 12;
const GAP = 10;
const opening = { duration: 240, easing: Easing.bezier(0.16, 1, 0.3, 1) };
const closing = { duration: 150, easing: Easing.bezier(0.4, 0, 1, 1) };

export function ContextMenuHost() {
  const request = useSyncExternalStore(subscribeMenu, () => current);
  if (!request) return null;
  return <MenuPanel key={request.id} request={request} onClosed={() => { if (current?.id === request.id) publish(null); }} />;
}

function MenuPanel({ request, onClosed }: { request: MenuRequest; onClosed: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const shown = useSharedValue(0);
  const closingNow = useRef(false);
  const lifted = request.lifted;
  const anchor = request.anchor ?? (lifted ? { x: lifted.frame.x + lifted.frame.width / 2, y: lifted.frame.y + lifted.frame.height } : { x: width / 2, y: height / 2 });

  useEffect(() => {
    if (size) shown.set(withTiming(1, opening));
    return () => cancelAnimation(shown);
  }, [size, shown]);
  const close = (then?: () => void) => {
    if (closingNow.current) return;
    closingNow.current = true;
    shown.set(withTiming(0, closing, finished => { if (finished) scheduleOnRN(onClosed); }));
    // The choice runs as the menu leaves, so its result (a sheet, a page) arrives right after.
    if (then) setTimeout(then, 90);
  };
  useEffect(() => {
    dismiss = () => close();
    const back = BackHandler.addEventListener("hardwareBackPress", () => { close(); return true; });
    return () => { back.remove(); dismiss = null; };
  });

  const top0 = insets.top + EDGE;
  const bottom0 = height - insets.bottom - EDGE;
  const panelWidth = Math.min(WIDTH, width - EDGE * 2);
  // Beside a lifted row: aligned to its right edge, under it when there's room, else above.
  const left = lifted
    ? Math.min(Math.max(EDGE, lifted.frame.x + lifted.frame.width - panelWidth - 8), width - EDGE - panelWidth)
    : Math.min(Math.max(EDGE, anchor.x - panelWidth / 2), width - EDGE - panelWidth);
  const startY = lifted ? lifted.frame.y + lifted.frame.height + GAP : anchor.y + 14;
  const endY = lifted ? lifted.frame.y - GAP : anchor.y - 14;
  const below = !size || startY + size.height <= bottom0 || bottom0 - startY >= endY - top0;
  const room = below ? bottom0 - startY : endY - top0;
  const panelHeight = size ? Math.min(size.height, Math.max(160, room)) : undefined;
  const top = !size || !panelHeight ? startY : below ? Math.min(startY, bottom0 - panelHeight) : Math.max(top0, endY - panelHeight);
  const originX = Math.min(Math.max(0, anchor.x - left), panelWidth);
  const originY = below ? 0 : panelHeight ?? 0;

  const backdropStyle = useAnimatedStyle(() => ({ opacity: shown.get() }));
  const panelStyle = useAnimatedStyle(() => {
    const t = shown.get();
    return { opacity: Math.min(1, t * 1.4), transform: [{ scale: 0.86 + 0.14 * t }] };
  });
  // The held row rises a touch and casts a shadow, staying sharp above the dimmed screen.
  const liftedStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 + 0.025 * shown.get() }], shadowOpacity: 0.6 * shown.get() }));

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, backdropStyle]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close menu" style={StyleSheet.absoluteFill} onPress={() => close()} />
      </Animated.View>
      {lifted && <Animated.View pointerEvents="none" style={[styles.lifted, { left: lifted.frame.x, top: lifted.frame.y, width: lifted.frame.width, height: lifted.frame.height }, liftedStyle]}>
        {lifted.node}
      </Animated.View>}
      <Animated.View
        accessibilityViewIsModal
        onAccessibilityEscape={() => close()}
        style={[styles.panel, { left, top, width: panelWidth, height: panelHeight, transformOrigin: `${originX}px ${originY}px 0px` }, !size && styles.measuring, panelStyle]}
      >
        <BlurView pointerEvents="none" tint="dark" intensity={50} style={StyleSheet.absoluteFill} />
        <ScrollView bounces={false} scrollEnabled={!!size && !!panelHeight && panelHeight < size.height} showsVerticalScrollIndicator={false}>
          <View onLayout={event => { if (!size) setSize(event.nativeEvent.layout); }}>
            {!lifted && (request.track || request.title) && <View style={styles.heading}>
              {request.track && <Artwork track={request.track} size={40} />}
              <View style={styles.headingText}>
                <Text numberOfLines={1} style={styles.title}>{request.track?.name ?? request.title}</Text>
                {(request.track?.artist ?? request.subtitle) && <Text numberOfLines={1} style={styles.subtitle}>{request.track?.artist ?? request.subtitle}</Text>}
              </View>
            </View>}
            {request.actions.map((action, index) => (
              <MenuItem key={action.label} action={action} divider={index > 0 || (!lifted && !!(request.track || request.title))} onPress={() => close(action.run)} />
            ))}
          </View>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function MenuItem({ action, divider, onPress }: { action: MenuAction; divider: boolean; onPress: () => void }) {
  const tint = action.destructive ? colors.error : colors.text;
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={{ disabled: action.disabled }}
      disabled={action.disabled}
      onPressIn={() => haptic.tick()}
      onPress={onPress}
      style={({ pressed }) => [styles.item, divider && (action.section ? styles.section : styles.divider), pressed && styles.pressed, action.disabled && styles.disabled]}
    >
      <Text style={[styles.label, { color: tint }]} numberOfLines={1}>{action.label}</Text>
      <Icon name={action.icon} size={sizes.menuIcon} color={tint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: "rgba(0, 0, 0, 0.62)" },
  lifted: {
    position: "absolute",
    borderRadius: radius.md,
    borderCurve: "continuous",
    backgroundColor: colors.black,
    shadowColor: "black",
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
  },
  panel: {
    position: "absolute",
    overflow: "hidden",
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: glass.border,
    backgroundColor: glass.panel,
  },
  measuring: { opacity: 0 },
  heading: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  headingText: { flex: 1, gap: 2 },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.small, fontWeight: "600" },
  subtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.detail },
  item: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 46, paddingHorizontal: space.lg },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: glass.border },
  // A thicker rule between playback and editing, as desktop's menus group them.
  section: { borderTopWidth: 6, borderTopColor: "rgba(0, 0, 0, 0.45)" },
  pressed: { backgroundColor: "rgba(255, 255, 255, 0.1)" },
  disabled: { opacity: 0.4 },
  label: { flex: 1, fontFamily: fonts.sans, fontSize: 15 },
});
