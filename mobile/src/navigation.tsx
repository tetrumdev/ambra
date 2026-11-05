import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BackHandler, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeInDown, FadeOut, SlideInRight } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CatalogAlbum, CatalogArtist } from "../../desktop/src/api/server";
import type { SessionView } from "./client";
import { Icon } from "./Icons";
import type { Service } from "./servicePreferences";
import { colors, fonts, haptic } from "./theme";
import { Touchable } from "./Touchable";

/** Desktop's views, one stack per tab: pages open on top and Back returns, as in the sidebar's history. */
export type Route =
  | { kind: "home" }
  | { kind: "library" }
  | { kind: "search" }
  | { kind: "settings" }
  | { kind: "section"; section: "artists" | "albums" | "tracks" }
  | { kind: "playlist"; id: string; provider?: Service; name: string }
  | { kind: "album"; album: CatalogAlbum }
  | { kind: "artist"; artist: CatalogArtist }
  | { kind: "downloads" };

export type Tab = "Home" | "Library" | "Search" | "Settings";
export const tabs: Tab[] = ["Home", "Library", "Search", "Settings"];
const roots: Record<Tab, Route> = { Home: { kind: "home" }, Library: { kind: "library" }, Search: { kind: "search" }, Settings: { kind: "settings" } };

type Navigation = {
  push(route: Route): void;
  back(): void;
  canGoBack: boolean;
  view: SessionView | null;
  bottomInset: number;
  /** Hides the dock while a menu is open, as the MEGA list always did. */
  onMenuVisibilityChange(visible: boolean): void;
};

const NavigationContext = createContext<Navigation | null>(null);
export function useNavigation() {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error("Screens need the navigation stack");
  return navigation;
}

/** Each tab keeps its own pages, so switching tabs and back keeps your place. */
export function TabStacks({ tab, view, bottomInset, onMenuVisibilityChange, render, onTabRoot }: {
  tab: Tab;
  view: SessionView | null;
  bottomInset: number;
  onMenuVisibilityChange(visible: boolean): void;
  render(route: Route): ReactNode;
  /** Asks to switch tabs, e.g. when a page links to Settings. */
  onTabRoot?: (tab: Tab) => void;
}) {
  const [stacks, setStacks] = useState<Record<Tab, Route[]>>(() => ({ Home: [roots.Home], Library: [roots.Library], Search: [roots.Search], Settings: [roots.Settings] }));
  const stack = stacks[tab];
  const route = stack[stack.length - 1];
  const push = useCallback((next: Route) => {
    if (next.kind === "settings") { onTabRoot?.("Settings"); return; }
    setStacks(current => ({ ...current, [tab]: [...current[tab], next].slice(-30) }));
  }, [tab, onTabRoot]);
  const back = useCallback(() => setStacks(current => current[tab].length > 1 ? { ...current, [tab]: current[tab].slice(0, -1) } : current), [tab]);
  const canGoBack = stack.length > 1;
  useEffect(() => {
    if (!canGoBack) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { back(); return true; });
    return () => subscription.remove();
  }, [canGoBack, back]);
  const value = useMemo(() => ({ push, back, canGoBack, view, bottomInset, onMenuVisibilityChange }), [push, back, canGoBack, view, bottomInset, onMenuVisibilityChange]);
  return (
    <NavigationContext.Provider value={value}>
      <Animated.View key={`${tab}:${stack.length}`} entering={stack.length > 1 ? SlideInRight.duration(240) : FadeIn.duration(160)} style={styles.page}>
        {render(route)}
      </Animated.View>
    </NavigationContext.Provider>
  );
}

/** A page's title row, with Back when there's somewhere to go back to. */
export function ScreenHeader({ title, subtitle, right }: { title?: string; subtitle?: string; right?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { canGoBack, back } = useNavigation();
  return (
    <View style={[styles.header, { paddingTop: insets.top + (canGoBack ? 4 : 24) }]}>
      {canGoBack && <Touchable accessibilityRole="button" accessibilityLabel="Back" haptic="tap" scale={0.9} onPress={back} style={styles.back}>
        <Icon name="back" size={18} />
      </Touchable>}
      {title !== undefined && <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text accessibilityRole="header" style={styles.title} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>{title}</Text>
          {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        </View>
        {right}
      </View>}
    </View>
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
  toastTimer = setTimeout(() => { toast = null; for (const listener of toastListeners) listener(); }, 2400);
}

export function ToastHost({ bottom }: { bottom: number }) {
  const current = useSyncExternalStore(listener => { toastListeners.add(listener); return () => { toastListeners.delete(listener); }; }, () => toast);
  if (!current) return null;
  return (
    <Animated.View key={current.id} entering={FadeInDown.duration(220)} exiting={FadeOut.duration(160)} pointerEvents="none" style={[styles.toast, { bottom }]}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.toastText, current.error && { color: colors.error }]}>{current.text}</Text>
    </Animated.View>
  );
}

export const reason = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/** Runs a change, telling the listener how it went; playback needs an output first, as desktop's player does. */
export function useRun() {
  const { view } = useNavigation();
  const latest = useRef(view);
  useLayoutEffect(() => { latest.current = view; });
  return useCallback((work: () => Promise<unknown>, done?: string, needsOutput = true) => {
    if (needsOutput && !latest.current?.output) {
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
  page: { flex: 1, backgroundColor: colors.black },
  header: { paddingHorizontal: 20 },
  back: { width: 44, height: 44, marginLeft: -12, alignItems: "center", justifyContent: "center" },
  headerRow: { flexDirection: "row", alignItems: "flex-end", gap: 12, paddingBottom: 16 },
  headerText: { flex: 1, gap: 6 },
  title: { color: "white", fontFamily: fonts.serif, fontSize: 38, fontWeight: "500" },
  subtitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  toast: { position: "absolute", alignSelf: "center", backgroundColor: colors.raised, borderColor: "#2f2f2f", borderWidth: StyleSheet.hairlineWidth, borderRadius: 100, paddingHorizontal: 18, paddingVertical: 10, maxWidth: "90%" },
  toastText: { color: "white", fontFamily: fonts.sans, fontSize: 13, fontWeight: "600", textAlign: "center" },
});
