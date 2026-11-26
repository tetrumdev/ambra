import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Animated as RNAnimated, BackHandler, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import type { CatalogAlbum, CatalogArtist, RecommendationMix } from "../../desktop/src/api/server";
import { currentTrack, sessionView, subscribe as subscribeSession } from "./client";
import { Icon } from "./Icons";
import type { Service } from "./servicePreferences";
import { PageGestureContext } from "./shell/gestures";
import { colors, fonts, glass, haptic, radius, rubberBand, space, springs, textSize } from "./theme";
import { Touchable } from "./Touchable";

/** Desktop's views, one stack per tab: pages open on top and Back returns, as in the sidebar's history. */
export type Route =
  | { kind: "home" }
  | { kind: "library" }
  | { kind: "search" }
  | { kind: "settings" }
  | { kind: "section"; section: "artists" | "albums" | "tracks" }
  | { kind: "playlist"; id: string; provider?: Service; name: string }
  | { kind: "mix"; provider: Service; mix: RecommendationMix }
  | { kind: "album"; album: CatalogAlbum }
  | { kind: "artist"; artist: CatalogArtist }
  | { kind: "downloads"; collection?: string };

export type Tab = "Home" | "Search" | "Library";
export const tabs: Tab[] = ["Home", "Search", "Library"];
type Entry = { id: number; route: Route };
let nextEntry = 3;
const roots: Record<Tab, Entry[]> = { Home: [{ id: 0, route: { kind: "home" } }], Search: [{ id: 1, route: { kind: "search" } }], Library: [{ id: 2, route: { kind: "library" } }] };
/** Pages kept mounted under the top one, so going back returns to the same scroll position. */
const KEPT = 8;
const enterTiming = { duration: 300, easing: Easing.bezier(0.16, 1, 0.3, 1) };
/** How far the page underneath sits to the left while another covers it. */
const UNDER = 0.28;

type Navigation = {
  push(route: Route): void;
  back(): void;
  canGoBack: boolean;
  bottomInset: number;
};

const NavigationContext = createContext<Navigation | null>(null);
/** Where a page sits in its tab's stack; headers show Back on every page but the first. */
const PageIndexContext = createContext(0);
/** Whether a page is the one in front (top of the chosen tab), and how often its tab was tapped again. */
const FrontPageContext = createContext({ front: false, toTop: 0 });
type Scrollable = { scrollTo?(options: { y: number; animated: boolean }): void; scrollToOffset?(options: { offset: number; animated: boolean }): void };

/**
 * iOS's conventions for a page's list: tapping the status bar scrolls the page in front to the
 * top (iOS does it only while just one list on screen asks for it, so the others don't), and
 * so does tapping its tab again. Returns the list's `scrollsToTop`.
 */
export function useFrontPageScroll(list: { current: unknown }) {
  const { front, toTop } = useContext(FrontPageContext);
  const handled = useRef(toTop);
  useEffect(() => {
    if (toTop === handled.current) return;
    handled.current = toTop;
    if (!front) return;
    const target = list.current as Scrollable | null;
    if (target?.scrollToOffset) target.scrollToOffset({ offset: 0, animated: true });
    else target?.scrollTo?.({ y: 0, animated: true });
  }, [toTop, front, list]);
  return front;
}
export function useNavigation() {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error("Screens need the navigation stack");
  return navigation;
}

/**
 * The tabs side by side, each with its own stack of pages. Swiping sideways anywhere moves
 * between tabs, with the page following the finger; on a pushed page the same swipe drags it
 * away to go back, revealing the page underneath as it slides out from the left.
 */
export type Navigator = { push(route: Route): void };

/** Memoized: the player re-renders with every session update, and the pages needn't. */
export const TabPager = memo(function TabPager({ tab, onTab, page, bottomInset, popToRoot, onNavigator, render }: {
  tab: Tab;
  onTab(tab: Tab): void;
  /** Which tab shows, fractional mid-swipe; the tab bar's lens follows it too. */
  page: SharedValue<number>;
  bottomInset: number;
  /** Bumped by tapping the tab that is already chosen. */
  popToRoot: number;
  /** Lets surfaces outside the pages (the player) open pages. */
  onNavigator?: (navigator: Navigator) => void;
  render(route: Route): ReactNode;
}) {
  const { width } = useWindowDimensions();
  const [stacks, setStacks] = useState<Record<Tab, Entry[]>>(roots);
  // Each tab's stack position: 2 shows its third page; 1.5 is halfway back to the second.
  const homeDepth = useSharedValue(0);
  const searchDepth = useSharedValue(0);
  const libraryDepth = useSharedValue(0);
  const depths: Record<Tab, SharedValue<number>> = { Home: homeDepth, Search: searchDepth, Library: libraryDepth };
  const latest = useRef({ tab, stacks, width, onTab });
  useLayoutEffect(() => { latest.current = { tab, stacks, width, onTab }; });

  const push = useCallback((next: Route) => {
    const current = latest.current.tab;
    const length = latest.current.stacks[current].length;
    const entry = { id: nextEntry++, route: next };
    setStacks(all => ({ ...all, [current]: [...all[current], entry] }));
    // The new page mounts a whole width to the right, then slides in over the current one.
    depths[current].set(withTiming(length, enterTiming));
    // depths is a fixed set of shared values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { onNavigator?.({ push }); }, [onNavigator, push]);
  const pop = useCallback((which: Tab) => setStacks(all => all[which].length > 1 ? { ...all, [which]: all[which].slice(0, -1) } : all), []);
  const back = useCallback((velocity = 0) => {
    const current = latest.current.tab;
    const length = latest.current.stacks[current].length;
    if (length < 2) return;
    const to = length - 2;
    depths[current].set(withSpring(to, { ...springs.settle, velocity }, done => { if (done) scheduleOnRN(pop, current); }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pop]);
  useEffect(() => {
    if (!popToRoot) return;
    const current = latest.current.tab;
    if (latest.current.stacks[current].length < 2) return;
    depths[current].set(withTiming(0, enterTiming, done => { if (done) scheduleOnRN(() => setStacks(all => ({ ...all, [current]: all[current].slice(0, 1) }))); }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popToRoot]);
  const canGoBack = stacks[tab].length > 1;
  useEffect(() => {
    if (!canGoBack) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { back(); return true; });
    return () => subscription.remove();
  }, [canGoBack, back]);

  const drag = useRef({ mode: "tabs" as "tabs" | "back", start: 0, slot: 0 });
  const begin = (edge: boolean) => {
    const { tab: current, stacks: all } = latest.current;
    const deep = all[current].length > 1;
    drag.current = deep || edge
      ? { mode: "back", start: all[current].length - 1, slot: 0 }
      : { mode: "tabs", start: page.get(), slot: Math.round(page.get()) };
  };
  const move = (translationX: number) => {
    const { tab: current, width: w } = latest.current;
    if (drag.current.mode === "back") {
      const { start } = drag.current;
      const pulled = translationX >= 0 ? translationX / w : rubberBand(translationX, 30) / w;
      depths[current].set(Math.min(start + 0.04, Math.max(start - 1, start - pulled)));
      return;
    }
    const raw = drag.current.start - translationX / w;
    const last = tabs.length - 1;
    const value = raw < 0 ? rubberBand(raw * w, w * 0.4) / w : raw > last ? last + rubberBand((raw - last) * w, w * 0.4) / w : raw;
    page.set(value);
    const slot = Math.round(Math.min(last, Math.max(0, value)));
    if (slot !== drag.current.slot) { drag.current.slot = slot; haptic.tick(); }
  };
  const end = (translationX: number, velocityX: number, canceled: boolean) => {
    const { tab: current, width: w, stacks: all } = latest.current;
    if (drag.current.mode === "back") {
      const length = all[current].length;
      if (length < 2) { depths[current].set(withSpring(0, springs.settle)); return; }
      const going = !canceled && (translationX > w * 0.4 || (velocityX > 500 && translationX > 12));
      if (going) { haptic.tap(); back(velocityX / w); }
      else depths[current].set(withSpring(length - 1, { ...springs.settle, velocity: -velocityX / w }));
      return;
    }
    const start = Math.round(drag.current.start);
    const projected = page.get() - (canceled ? 0 : velocityX / w * 0.25);
    const target = Math.min(tabs.length - 1, Math.max(0, Math.min(start + 1, Math.max(start - 1, Math.round(projected)))));
    page.set(withSpring(target, { ...springs.settle, velocity: -velocityX / w }));
    if (tabs[target] !== current) latest.current.onTab(tabs[target]);
  };
  const pagePan = usePanGesture({
    runOnJS: true,
    activeOffsetX: [-12, 12],
    failOffsetY: [-12, 12],
    onActivate: () => begin(false),
    onUpdate: event => move(event.translationX),
    onDeactivate: event => end(event.translationX, event.velocityX, event.canceled),
  });
  // Pushed pages can always be dragged back from the screen's left edge, even over swipeable rows.
  const edgePan = usePanGesture({
    runOnJS: true,
    enabled: canGoBack,
    activeOffsetX: 6,
    failOffsetY: [-16, 16],
    onActivate: () => begin(true),
    onUpdate: event => move(event.translationX),
    onDeactivate: event => end(event.translationX, event.velocityX, event.canceled),
  });

  const value = useMemo(() => ({ push, back: () => back(), canGoBack, bottomInset }), [push, back, canGoBack, bottomInset]);
  return (
    <NavigationContext.Provider value={value}>
      <PageGestureContext.Provider value={pagePan}>
        <GestureDetector gesture={pagePan}>
          <View collapsable={false} style={styles.pager}>
            {tabs.map((name, index) => (
              <TabColumn key={name} index={index} page={page} width={width} active={name === tab}>
                {stacks[name].map(({ id, route }, at) => (
                  <StackPage key={id} index={at} depth={depths[name]} width={width} top={at === stacks[name].length - 1} front={name === tab && at === stacks[name].length - 1} toTop={popToRoot} kept={at >= stacks[name].length - KEPT}>
                    {render(route)}
                  </StackPage>
                ))}
              </TabColumn>
            ))}
            {canGoBack && <GestureDetector gesture={edgePan}><View collapsable={false} style={styles.edge} /></GestureDetector>}
          </View>
        </GestureDetector>
      </PageGestureContext.Provider>
    </NavigationContext.Provider>
  );
});

function TabColumn({ index, page, width, active, children }: { index: number; page: SharedValue<number>; width: number; active: boolean; children: ReactNode }) {
  const style = useAnimatedStyle(() => {
    const offset = index - page.get();
    // Neighbours sit a little behind and dimmer, so the swipe reads as moving between cards.
    return {
      transform: [{ translateX: offset * width }, { scale: 1 - Math.min(1, Math.abs(offset)) * 0.06 }],
      opacity: 1 - Math.min(1, Math.abs(offset)) * 0.5,
    };
  });
  return (
    <Animated.View pointerEvents={active ? "auto" : "none"} accessibilityElementsHidden={!active} importantForAccessibility={active ? "auto" : "no-hide-descendants"} style={[StyleSheet.absoluteFill, style]}>
      {children}
    </Animated.View>
  );
}

function StackPage({ index, depth, width, top, front, toTop, kept, children }: { index: number; depth: SharedValue<number>; width: number; top: boolean; front: boolean; toTop: number; kept: boolean; children: ReactNode }) {
  const frontPage = useMemo(() => ({ front, toTop }), [front, toTop]);
  const style = useAnimatedStyle(() => {
    const offset = index - depth.get();
    if (offset >= 0) return { transform: [{ translateX: Math.min(1, offset) * width }], opacity: 1 };
    return { transform: [{ translateX: Math.max(-1, offset) * width * UNDER }], opacity: offset < -1.01 ? 0 : 1 };
  });
  const shade = useAnimatedStyle(() => ({ opacity: Math.min(1, Math.max(0, depth.get() - index)) * 0.55 }));
  const edge = useAnimatedStyle(() => ({ opacity: index > 0 ? Math.min(1, Math.max(0, 1 - Math.abs(index - depth.get()))) : 0 }));
  if (!kept) return null;
  return (
    <Animated.View pointerEvents={top ? "auto" : "none"} accessibilityElementsHidden={!top} importantForAccessibility={top ? "auto" : "no-hide-descendants"} style={[StyleSheet.absoluteFill, styles.page, style]}>
      <PageIndexContext.Provider value={index}><FrontPageContext.Provider value={frontPage}>{children}</FrontPageContext.Provider></PageIndexContext.Provider>
      {index > 0 && <Animated.View pointerEvents="none" style={[styles.pageEdge, edge]} />}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shade, shade]} />
    </Animated.View>
  );
}

/**
 * A page's title: large and serif at the top, as on desktop, shrinking into a compact bar with
 * Back as the page scrolls. `scroll` is the list's native-driven scroll offset.
 */
export function PageHeader({ title, subtitle, right, scroll, large = true }: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  scroll?: RNAnimated.Value;
  large?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { back } = useNavigation();
  // This page's own place, not the stack's: a first page under a pushed one keeps its layout.
  const canGoBack = useContext(PageIndexContext) > 0;
  return (
    <View style={[styles.header, { paddingTop: insets.top + (canGoBack ? 52 : 28) }]}>
      {title !== undefined && large && <RNAnimated.View style={[styles.headerRow, scroll && {
        opacity: scroll.interpolate({ inputRange: [0, 50], outputRange: [1, 0], extrapolate: "clamp" }),
        transform: [{ scale: scroll.interpolate({ inputRange: [-200, 0], outputRange: [1.12, 1], extrapolate: "clamp" }) }],
        transformOrigin: "left bottom",
      }]}>
        <View style={styles.headerText}>
          <Text accessibilityRole="header" style={styles.title} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>{title}</Text>
          {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        </View>
        {right}
      </RNAnimated.View>}
      {canGoBack && !scroll && <BackButton onPress={back} top={insets.top + 4} />}
    </View>
  );
}

/** The bar that settles over a scrolled page: Back, and the title once the large one has gone. */
export function CompactBar({ title, scroll, threshold = 60 }: { title?: string; scroll: RNAnimated.Value; threshold?: number }) {
  const insets = useSafeAreaInsets();
  const { back } = useNavigation();
  const canGoBack = useContext(PageIndexContext) > 0;
  const shown = scroll.interpolate({ inputRange: [threshold - 20, threshold + 10], outputRange: [0, 1], extrapolate: "clamp" });
  return (
    <View pointerEvents="box-none" style={[styles.compact, { height: insets.top + 48 }]}>
      <RNAnimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.compactFill, { opacity: shown }]} />
      <RNAnimated.Text numberOfLines={1} style={[styles.compactTitle, { top: insets.top + 13, opacity: shown, transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}>{title}</RNAnimated.Text>
      {canGoBack && <BackButton onPress={back} top={insets.top + 2} />}
    </View>
  );
}

function BackButton({ onPress, top }: { onPress(): void; top: number }) {
  return (
    <Touchable accessibilityRole="button" accessibilityLabel="Back" accessibilityHint="Or swipe right" haptic="tap" scale={0.85} onPress={onPress} style={[styles.back, { top }]}>
      <Icon name="back" size={18} />
    </Touchable>
  );
}

type Toast = { id: number; text: string; error: boolean };
let toast: Toast | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const toastListeners = new Set<() => void>();
/** Brief word that something off-screen happened, like a song joining the queue. */
export function showToast(text: string, error = false) {
  clearTimeout(toastTimer);
  toast = { id: Date.now(), text, error };
  for (const listener of toastListeners) listener();
  toastTimer = setTimeout(() => { toast = null; for (const listener of toastListeners) listener(); }, 2200);
}

export function ToastHost({ bottom }: { bottom: number }) {
  const current = useSyncExternalStore(listener => { toastListeners.add(listener); return () => { toastListeners.delete(listener); }; }, () => toast);
  if (!current) return null;
  return (
    <Animated.View key={current.id} entering={FadeIn.duration(200)} exiting={FadeOut.duration(160)} pointerEvents="none" style={[styles.toast, { bottom }]}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.toastText, current.error && { color: colors.error }]}>{current.text}</Text>
    </Animated.View>
  );
}

export const reason = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/**
 * What pages show of playback: the song playing, whether it plays, and where. Pages re-render
 * only when one of these changes, not on every session update (positions, queue revisions),
 * which would redraw every list in every tab on the JS thread.
 */
export function useNowPlaying() {
  const key = useSyncExternalStore(subscribeSession, () => {
    const view = sessionView();
    return JSON.stringify([currentTrack(view)?.globalId ?? null, !!view?.playing, view?.output?.deviceName ?? null]);
  });
  return useMemo(() => {
    const [trackId, playing, outputName] = JSON.parse(key) as [string | null, boolean, string | null];
    return { trackId, playing, outputName };
  }, [key]);
}

/** Runs a change, telling the listener how it went; playback needs an output first, as desktop's player does. */
export function useRun() {
  return useCallback((work: () => Promise<unknown>, done?: string, needsOutput = true) => {
    if (needsOutput && !sessionView()?.output) {
      haptic.warning();
      showToast("Choose an output in the player first", true);
      return;
    }
    void work().then(() => {
      if (!done) return;
      haptic.success();
      showToast(done);
    }).catch(error => {
      haptic.error();
      showToast(reason(error, "Something went wrong. Please try again."), true);
    });
  }, []);
}

const styles = StyleSheet.create({
  pager: { flex: 1, overflow: "hidden", backgroundColor: colors.black },
  page: { backgroundColor: colors.black },
  pageEdge: { position: "absolute", left: -1, top: 0, bottom: 0, width: 1, backgroundColor: "rgba(255, 255, 255, 0.08)" },
  shade: { backgroundColor: colors.black },
  edge: { position: "absolute", left: 0, top: 0, bottom: 0, width: 22 },
  header: { paddingHorizontal: 20 },
  back: { position: "absolute", left: 8, width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.pill },
  headerRow: { flexDirection: "row", alignItems: "flex-end", gap: space.md, paddingBottom: 16 },
  headerText: { flex: 1, gap: 6 },
  title: { color: colors.text, fontFamily: fonts.serif, fontSize: textSize.page, fontWeight: "500" },
  subtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.detail },
  compact: { position: "absolute", left: 0, right: 0, top: 0 },
  compactFill: { backgroundColor: colors.black, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  compactTitle: { position: "absolute", left: 60, right: 60, textAlign: "center", color: colors.text, fontFamily: fonts.sans, fontSize: 16, fontWeight: "600" },
  toast: { position: "absolute", alignSelf: "center", backgroundColor: glass.panel, borderColor: glass.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: 18, paddingVertical: 10, maxWidth: "90%" },
  toastText: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.detail, fontWeight: "600", textAlign: "center" },
});
