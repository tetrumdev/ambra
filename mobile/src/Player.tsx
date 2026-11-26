import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
  type ComponentType,
  type ReactElement,
} from "react";
import { BackHandler, StyleSheet, Text, View, useWindowDimensions, type ViewProps } from "react-native";
import { BlurTargetView, BlurView } from "expo-blur";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { GestureDetector, useExclusiveGestures, useLongPressGesture, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { Image } from "expo-image";
import {
  command,
  currentTrack,
  offlineActive,
  playingOutputs,
  sessionView,
  sessionViewAge,
  subscribe,
  type SessionView,
  type Track,
} from "./client";
import { Controls, PlayPauseButton } from "./Controls";
import { StatusDot } from "./StatusDot";
import { AlbumCover } from "./AlbumCover";
import { Artwork } from "./Artwork";
import { LyricsView } from "./LyricsView";
import { prefetchLyrics } from "./useLyrics";
import { playerTiming } from "./playerMotion";
import { Progress } from "./Progress";
import { SongText } from "./SongText";
import { Swirl } from "./Swirl";
import { Icon } from "./Icons";
import { QueueSheet } from "./TrackBrowser";
import { TabPager, ToastHost, reason, showToast, tabs, type Navigator, type Route, type Tab } from "./navigation";
import { AlbumScreen, ArtistScreen, DownloadsScreen, HomeScreen, LibraryScreen, MixScreen, PlaylistScreen, SectionScreen } from "./screens/Pages";
import { SheetHosts } from "./Sheets";
import { OutputPicker } from "./OutputPicker";
import { colors, fonts, haptic, radius, rubberBand, space, springs, textSize } from "./theme";
import { HOLD_MS, Touchable } from "./Touchable";
import { MINI_HEIGHT, NAVIGATION_HEIGHT, playerFrame, playerLayout } from "./playerGeometry";
import { SearchScreen } from "./SearchScreen";
import { SettingsScreen } from "./SettingsScreen";
import { loadServicePreferences } from "./servicePreferences";
import { ContextMenuHost, openMenu } from "./shell/ContextMenu";
import { sheetDepth } from "./shell/chrome";
import { TabBar } from "./shell/TabBar";
import { editActions } from "./TrackMenus";

const PAUSED_COVER_SCALE = 0.9;
/** Space between covers in the open player's carousel. */
const CAROUSEL_GAP = 28;
/** Song text size in each placement, relative to the open player's 19-point title. */
const TEXT_SCALE = { mini: 14 / 19, expanded: 1, header: 16 / 19 };
const tick = () => haptic.tick();
const firm = () => haptic.firm();
const tap = () => haptic.tap();
const coverSpring = { damping: 20, stiffness: 140, mass: 1 };
/** Opening and closing the player: quick, settled, never bouncing past the screen's edge. */
const sheetSpring = { damping: 34, stiffness: 300, mass: 1, overshootClamping: true };
/** Pulling the open player up this far, then letting go, opens the queue. */
const PULL_FOR_QUEUE = 72;
// MaskedView 0.3.2's constructor intersection loses React component props with TypeScript 6.
const DockMask = MaskedView as unknown as ComponentType<ViewProps & { maskElement: ReactElement }>;

/** Where the song is now: the last report carried forward while playing. */
function usePosition(playing: boolean, reported: number, duration: number) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => tick((value) => value + 1), 250);
    return () => clearInterval(timer);
  }, [playing]);
  return Math.min(duration, reported + (playing ? sessionViewAge() : 0));
}

/** The clock ticks here alone, and only while the player is open, so the rest of the screen stays still. */
function LiveProgress({ view, duration, active, disabled, onSeek }: {
  view: SessionView | null;
  duration: number;
  active: boolean;
  disabled: boolean;
  onSeek: (seconds: number) => void;
}) {
  const position = usePosition(active && !!view?.playing && !view.buffering, view?.positionSeconds ?? 0, duration);
  return <Progress position={position} duration={duration} revision={view?.revision ?? 0} disabled={disabled} onSeek={onSeek} />;
}

/**
 * The mini-player's line. It moves about a point a second, so it's set twice a second rather
 * than animated every frame for a whole song, which kept the display redrawing nonstop.
 */
function MiniProgress({ view, duration, shown }: { view: SessionView | null; duration: number; shown: boolean }) {
  const fill = useSharedValue(0);
  useEffect(() => {
    if (!view || duration <= 0) { fill.set(0); return; }
    const playing = view.playing && !view.buffering;
    const at = () => Math.min(1, (view.positionSeconds + (playing ? sessionViewAge() : 0)) / duration);
    fill.set(at());
    if (!playing || !shown) return;
    const timer = setInterval(() => fill.set(at()), 500);
    return () => clearInterval(timer);
  }, [view, duration, fill, shown]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.get() }] }));
  return <View style={styles.miniProgress}><Animated.View style={[styles.miniFill, style]} /></View>;
}

/** The song a swipe would move to, peeking in from the side it will come from. */
function Ghost({ track, label, side, skip, width }: { track: Track | null; label: string; side: 1 | -1; skip: SharedValue<number>; width: number }) {
  const style = useAnimatedStyle(() => {
    const x = skip.get();
    const toward = side === 1 ? -x : x;
    return { opacity: interpolate(toward, [10, 120], [0, 1], "clamp"), transform: [{ translateX: side * width + x }] };
  });
  return (
    <Animated.View pointerEvents="none" style={[styles.ghost, style]}>
      <Artwork track={track} size={44} />
      <View style={styles.ghostText}>
        <Text numberOfLines={1} style={styles.ghostLabel}>{label}</Text>
        <Text numberOfLines={1} style={styles.ghostTitle}>{track?.name ?? (side === 1 ? "End of queue" : "Start of song")}</Text>
      </View>
    </Animated.View>
  );
}

export function Player({ connectionError = null, onChangeServer }: { connectionError?: string | null; onChangeServer: () => void }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const layout = playerLayout(width, height, insets.top, insets.bottom);
  const [expanded, setExpanded] = useState(true);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const lyricsMode = useSharedValue(0);
  useEffect(() => { lyricsMode.set(withTiming(lyricsOpen ? 1 : 0, playerTiming)); }, [lyricsOpen, lyricsMode]);
  // Lyrics are built only while shown (and while fading out), not for every song in art view.
  const [lyricsMounted, setLyricsMounted] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLyricsMounted(lyricsOpen), lyricsOpen ? 0 : playerTiming.duration);
    return () => clearTimeout(timer);
  }, [lyricsOpen]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const libraryBackdrop = useRef<ComponentRef<typeof View>>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Home");
  const page = useSharedValue(0);
  const [popToRoot, setPopToRoot] = useState(0);
  const navigator = useRef<Navigator | null>(null);
  const takeNavigator = useCallback((next: Navigator) => { navigator.current = next; }, []);
  useEffect(() => { void loadServicePreferences().catch(failure => setError(String(failure))); }, []);
  // A normalized value preserves either endpoint when screen dimensions or safe areas change.
  const expansion = useSharedValue(1);
  const expandedNow = useRef(true);
  /** The same, for gestures running on the UI thread. */
  const expandedUI = useSharedValue(true);
  const commitExpanded = useCallback((open: boolean) => {
    expandedNow.current = open;
    setExpanded(open);
  }, []);
  const settle = useCallback((open: boolean, velocity = 0) => {
    commitExpanded(open);
    expandedUI.set(open);
    expansion.set(withSpring(open ? 1 : 0, { ...sheetSpring, velocity }));
  }, [expansion, expandedUI, commitExpanded]);
  const openPlayer = useCallback(() => settle(true), [settle]);
  const closePlayer = useCallback(() => settle(false), [settle]);
  const openQueue = useCallback(() => setQueueOpen(true), []);
  const closeQueue = useCallback(() => setQueueOpen(false), []);
  const closeOutput = useCallback(() => setOutputOpen(false), []);
  useEffect(() => () => cancelAnimation(expansion), [expansion]);
  useEffect(() => {
    if (!expanded) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => { closePlayer(); return true; });
    return () => back.remove();
  }, [expanded, closePlayer]);
  /** Opens a page from the player: it closes, revealing the page as it goes. */
  const pushFromPlayer = useCallback((route: Route) => { closePlayer(); navigator.current?.push(route); }, [closePlayer]);

  // The drag runs on the UI thread, so it never waits behind React or the swirl on the JS
  // thread; only haptics and the resulting state go back to React.
  const pull = useSharedValue(0);
  const dragStart = useSharedValue(1);
  const dragPassed = useSharedValue(false);
  const dragPulling = useSharedValue(false);
  const travel = Math.max(1, layout.miniTop);
  const threshold = Math.min(120, travel * 0.18);
  const onExpandActivate = () => {
    "worklet";
    cancelAnimation(expansion);
    dragStart.set(expansion.get());
    dragPassed.set(false);
    dragPulling.set(false);
  };
  const onExpandUpdate = (event: { translationY: number }) => {
    "worklet";
    // Open already and pulled further up: the player stretches toward the queue.
    if (dragStart.get() > 0.99 && event.translationY < 0) {
      expansion.set(1);
      const pulled = rubberBand(-event.translationY, 220);
      pull.set(pulled);
      const ready = pulled > PULL_FOR_QUEUE;
      if (ready !== dragPulling.get()) { dragPulling.set(ready); scheduleOnRN(ready ? firm : tick); }
      return;
    }
    pull.set(0);
    expansion.set(Math.min(1, Math.max(0, dragStart.get() - event.translationY / travel)));
    const past = Math.abs(event.translationY) > threshold;
    if (past !== dragPassed.get()) { dragPassed.set(past); scheduleOnRN(tick); }
  };
  const onExpandDeactivate = (event: { translationY: number; velocityY: number; canceled: boolean }) => {
    "worklet";
    pull.set(withSpring(0, springs.release));
    if (dragPulling.get() && !event.canceled) { dragPulling.set(false); scheduleOnRN(openQueue); return; }
    const wasOpen = expandedUI.get();
    const projected = expansion.get() - event.velocityY / travel * 0.18;
    const moved = Math.abs(event.translationY) > threshold;
    const open = event.canceled ? wasOpen
      : event.velocityY < -600 ? true
      : event.velocityY > 850 ? false
      : moved ? event.translationY < 0 : projected >= 0.5;
    if (open !== wasOpen) scheduleOnRN(tap);
    expandedUI.set(open);
    expansion.set(withSpring(open ? 1 : 0, { ...sheetSpring, velocity: event.canceled ? 0 : -event.velocityY / travel }));
    if (open !== wasOpen) scheduleOnRN(commitExpanded, open);
  };
  const gesturesEnabled = !queueOpen && !outputOpen;
  // The Worklets Babel plugin cannot transform spreads in gesture-hook objects.
  const pan = usePanGesture({
    enabled: gesturesEnabled && !(lyricsOpen && expanded),
    activeOffsetY: [-10, 10],
    failOffsetX: [-20, 20],
    onActivate: onExpandActivate,
    onUpdate: onExpandUpdate,
    onDeactivate: onExpandDeactivate,
  });
  const headerPan = usePanGesture({
    enabled: gesturesEnabled && lyricsOpen && expanded,
    activeOffsetY: [-10, 10],
    failOffsetX: [-20, 20],
    onActivate: onExpandActivate,
    onUpdate: onExpandUpdate,
    onDeactivate: onExpandDeactivate,
  });

  const skip = useRef({ direction: 1, at: 0 });
  const skipDirection = useCallback(
    () => (Date.now() - skip.current.at < 3000 ? skip.current.direction : 1),
    [],
  );
  const view = useSyncExternalStore(subscribe, sessionView);
  const track = currentTrack(view);
  // Shown at once, and kept until the session says the same (or gives up on it): an answer that
  // still has the old state, or a position report on the way, would flick the button back.
  const [wanted, setWanted] = useState<boolean | null>(null);
  const confirmed = wanted !== null && (view?.playing ?? false) === wanted;
  useEffect(() => {
    if (wanted === null) return;
    const timer = setTimeout(() => setWanted(null), confirmed ? 0 : 3000);
    return () => clearTimeout(timer);
  }, [wanted, confirmed]);
  // A skip while playing keeps showing "playing": the output pauses for a moment while the next
  // song loads, which isn't a pause the listener asked for. It ends once the new song plays,
  // the listener pauses, or after a few seconds.
  const [skipHold, setSkipHold] = useState<{ from: string | null } | null>(null);
  const holding = !!skipHold && !(track?.globalId !== skipHold.from && view?.playing && !view.buffering);
  useEffect(() => {
    if (!skipHold) return;
    // Once the new song plays the hold is done, so a later pause shows at once.
    const timer = setTimeout(() => setSkipHold(null), holding ? 4000 : 0);
    return () => clearTimeout(timer);
  }, [skipHold, holding]);
  const playing = holding ? true : wanted ?? (view?.playing ?? false);
  const duration = view?.duration || track?.durationSeconds || 0;
  const disabled = !track || !view?.output;
  const send = (action: string, details?: Record<string, unknown>) => {
    if (action === "previous" || action === "next") {
      skip.current = { direction: action === "previous" ? -1 : 1, at: Date.now() };
      if (playing) setSkipHold({ from: track?.globalId ?? null });
    }
    if (action === "pause" || action === "play") setSkipHold(null);
    setError(null);
    void command(action, details).catch(failure => {
      setWanted(null);
      setSkipHold(null);
      haptic.error();
      setError(failure instanceof Error ? failure.message : "Couldn't update playback. Please try again.");
    });
  };
  const toggle = () => {
    setWanted(!playing);
    send(playing ? "pause" : "play");
  };
  const byId = new Map(view?.queue.tracks?.map(item => [item.globalId, item]));
  const nextTrack = byId.get(view?.queue.upcoming[0]?.globalTrackId ?? "") ?? null;
  // Lyrics load with the song, not when opened: the playing song's, then the next one's.
  useEffect(() => { prefetchLyrics(track); prefetchLyrics(nextTrack); }, [track?.globalId, nextTrack?.globalId]); // eslint-disable-line react-hooks/exhaustive-deps
  const previousTrack = byId.get(view?.queue.history?.at(-1)?.globalTrackId ?? "") ?? null;

  // Swiping the song sideways skips, in the mini-player and on the open player's cover alike.
  // Like a carousel, the neighbouring song slides in with the finger; letting go past the
  // threshold carries it the rest of the way, and it stays there until the server has moved on.
  const skipX = useSharedValue(0);
  const skipArmed = useSharedValue(0);
  const skipLimit = Math.min(110, width * 0.28);
  const carouselStep = layout.coverSize + CAROUSEL_GAP;
  const skipPending = useRef<{ from: string | null; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancelSkip = useCallback(() => {
    if (skipPending.current) clearTimeout(skipPending.current.timer);
    skipPending.current = null;
    skipX.set(withSpring(0, springs.settle));
  }, [skipX]);
  const commitSkip = (direction: number, armed: boolean) => {
    if (!armed) haptic.firm();
    if (skipPending.current) clearTimeout(skipPending.current.timer);
    skipPending.current = null;
    // A previous that restarts the song, or a next at the end of the queue, has nothing to
    // carry in: the cover slides back.
    const position = (view?.positionSeconds ?? 0) + (view?.playing ? sessionViewAge() : 0);
    if (direction > 0 ? !previousTrack || position > 3 : !nextTrack) {
      send(direction < 0 ? "next" : "previous");
      cancelSkip();
      return;
    }
    // Nothing to move to (a previous that restarts the song, the end of the queue): slide back.
    skipPending.current = { from: track?.globalId ?? null, timer: setTimeout(cancelSkip, 2500) };
    send(direction < 0 ? "next" : "previous");
  };
  // The new song's cover has replaced the old one in place: the carousel returns to rest
  // under it in the same frame, so the swap can't be seen.
  const coverShown = useCallback(() => {
    if (!skipPending.current) return;
    clearTimeout(skipPending.current.timer);
    skipPending.current = null;
    cancelAnimation(skipX);
    skipX.set(0);
  }, [skipX]);
  const coverInstant = useCallback(() => skipPending.current !== null && skipPending.current.from !== (track?.globalId ?? null), [track?.globalId]);
  useEffect(() => () => { if (skipPending.current) clearTimeout(skipPending.current.timer); }, []);
  const onSkipActivate = () => {
    "worklet";
    skipArmed.set(0);
    cancelAnimation(skipX);
  };
  const onSkipUpdate = (event: { translationX: number }) => {
    "worklet";
    const x = event.translationX;
    // Free within one song's width, then a growing resistance.
    const reach = expandedUI.get() ? carouselStep : width - 16;
    skipX.set(Math.abs(x) < reach ? x : Math.sign(x) * (reach + rubberBand(Math.abs(x) - reach, width * 0.4)));
    const armed = Math.abs(x) > skipLimit ? Math.sign(x) : 0;
    if (armed !== skipArmed.get()) { skipArmed.set(armed); scheduleOnRN(armed ? firm : tick); }
  };
  const onSkipDeactivate = (event: { translationX: number; velocityX: number; canceled: boolean }) => {
    "worklet";
    const armed = skipArmed.get();
    skipArmed.set(0);
    const flicked = Math.abs(event.velocityX) > 650 && Math.abs(event.translationX) > 24 ? Math.sign(event.velocityX) : 0;
    const direction = event.canceled ? 0 : armed || flicked;
    if (!direction) { skipX.set(withSpring(0, { ...springs.release, velocity: event.velocityX })); return; }
    const reach = expandedUI.get() ? carouselStep : width - 16;
    skipX.set(withSpring(direction * reach, { ...springs.settle, velocity: event.velocityX }));
    scheduleOnRN(commitSkip, direction, armed !== 0);
  };
  const skipEnabled = !disabled && gesturesEnabled;
  // One gesture per place it's attached: the mini-player, and the open player's cover.
  const miniSkip = usePanGesture({
    enabled: skipEnabled && !expanded,
    activeOffsetX: [-12, 12],
    failOffsetY: [-12, 12],
    onActivate: onSkipActivate,
    onUpdate: onSkipUpdate,
    onDeactivate: onSkipDeactivate,
  });
  const coverSkip = usePanGesture({
    enabled: skipEnabled && expanded && !lyricsOpen,
    activeOffsetX: [-12, 12],
    failOffsetY: [-12, 12],
    onActivate: onSkipActivate,
    onUpdate: onSkipUpdate,
    onDeactivate: onSkipDeactivate,
  });
  // Tap and hold on the cover are gestures too, so a drag that starts on the cover (to close the
  // player, or to skip) can never end as a tap that pauses or a hold that opens the menu.
  const coverTap = useTapGesture({
    runOnJS: true,
    enabled: !!track && expanded && !lyricsOpen,
    maxDistance: 8,
    onActivate: () => { haptic.firm(); toggle(); },
  });
  const coverHold = useLongPressGesture({
    runOnJS: true,
    enabled: !!track && expanded && !lyricsOpen,
    minDuration: HOLD_MS,
    maxDistance: 8,
    onActivate: event => { haptic.hold(); coverMenu({ x: event.absoluteX, y: event.absoluteY }); },
  });
  const coverGestures = useExclusiveGestures(coverSkip, coverHold, coverTap);

  // Like Apple Music, the cover steps back while paused, but remains 44 points in the mini-player.
  const coverScale = useSharedValue(playing ? 1 : PAUSED_COVER_SCALE);
  useEffect(() => {
    coverScale.set(withSpring(playing ? 1 : PAUSED_COVER_SCALE, coverSpring));
  }, [playing, coverScale]);
  const frame = useDerivedValue(() => playerFrame(layout, expansion.get(), coverScale.get(), lyricsMode.get()));
  // Safe-area geometry gives a device-scaled estimate; RN exposes no physical screen radius.
  const screenCornerRadius = Math.min(56, Math.max(24, insets.top));
  const surfaceStyle = useAnimatedStyle(() => {
    const f = frame.get();
    const corner = 18 + (screenCornerRadius - 18) * f.expansion;
    return {
      left: f.left, top: f.top, width: f.width, height: f.height,
      borderTopLeftRadius: corner, borderTopRightRadius: corner,
      borderBottomLeftRadius: 18 * (1 - f.expansion), borderBottomRightRadius: 18 * (1 - f.expansion),
    };
  });
  const backgroundStyle = useAnimatedStyle(() => {
    const p = frame.get().expansion;
    // A frosted lift off the page in the mini-player, its hairline giving it an edge; opaque
    // black soon after it starts to open, under the swirl.
    // Rounded: a spring creeping toward 1 makes numbers like 1.2e-8, which aren't valid in a
    // color string and crashed the native side.
    const level = Math.round(40 * (1 - p));
    const alpha = Math.round(1000 * Math.min(1, 0.4 + 4 * p)) / 1000;
    return { backgroundColor: `rgba(${level}, ${level}, ${level}, ${alpha})`, borderColor: `rgba(255, 255, 255, ${Math.round(140 * (1 - p)) / 1000})` };
  });
  // Transforms only: moving or resizing with left/top would lay the player out again every frame.
  const artStyle = useAnimatedStyle(() => {
    const f = frame.get();
    return { transform: [{ translateX: f.artLeft + skipX.get() }, { translateY: f.artTop }, { scale: f.artScale }] };
  });
  // The corner follows the cover's size changes but not the pause shrink, so play/pause only moves a transform.
  const artCornerStyle = useAnimatedStyle(() => {
    const f = playerFrame(layout, expansion.get(), 1, lyricsMode.get());
    return { borderRadius: f.artRadius / f.artScale };
  });
  // The neighbouring covers of the carousel, either side of the open player's cover.
  const carouselStyle = useAnimatedStyle(() => {
    const x = skipX.get();
    const p = frame.get().expansion;
    return { opacity: p > 0.98 && Math.abs(x) > 0.5 ? 1 : 0, transform: [{ translateX: x }] };
  });
  // The text is laid out at the open player's size and scaled, so its size follows the
  // transition continuously. Its layout width changes only between placements, while invisible.
  const [textMode, setTextMode] = useState<"mini" | "expanded" | "header">("expanded");
  useAnimatedReaction(() => frame.get().textHeader ? "header" : frame.get().textExpanded ? "expanded" : "mini", (mode, before) => {
    if (mode !== before) scheduleOnRN(setTextMode, mode);
  });
  const textStyle = useAnimatedStyle(() => {
    const f = frame.get();
    const x = skipX.get();
    return {
      opacity: f.textOpacity * (f.expansion < 0.5 ? 1 - Math.min(1, Math.abs(x) / 140) : 1 - Math.min(0.6, Math.abs(x) / carouselStep)),
      transform: [
        { translateX: f.textLeft + (f.expansion < 0.5 ? x : x * 0.25) },
        { translateY: f.textTop },
        { scale: TEXT_SCALE.mini + (TEXT_SCALE.expanded + (TEXT_SCALE.header - TEXT_SCALE.expanded) * lyricsMode.get() - TEXT_SCALE.mini) * f.expansion },
      ],
    };
  });
  const textWidth = (textMode === "mini" ? width - 16 - 66 - 96 : textMode === "header" ? width - 130 : width - 60) / TEXT_SCALE[textMode];
  const detailStyle = useAnimatedStyle(() => ({
    opacity: interpolate(frame.get().expansion, [0.35, 0.85], [0, 1], "clamp"),
    transform: [{ translateY: 24 * (1 - frame.get().expansion) - pull.get() * 0.35 }],
  }));
  const pullHintStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pull.get(), [12, PULL_FOR_QUEUE], [0, 1], "clamp"),
    transform: [{ translateY: -pull.get() * 0.5 }, { scale: interpolate(pull.get(), [PULL_FOR_QUEUE - 8, PULL_FOR_QUEUE + 8], [1, 1.08], "clamp") }],
  }));
  const lyricsStyle = useAnimatedStyle(() => ({ opacity: interpolate(expansion.get(), [0.7, 1], [0, 1], "clamp") * interpolate(lyricsMode.get(), [0.35, 1], [0, 1], "clamp") }));
  const progressStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (layout.lyricsProgressTop - layout.progressTop) * lyricsMode.get() }] }));
  const controlsStyle = useAnimatedStyle(() => ({ transform: [{ translateY: (layout.lyricsControlsTop - layout.controlsTop) * lyricsMode.get() }] }));
  const miniStyle = useAnimatedStyle(() => ({ opacity: interpolate(frame.get().expansion, [0, 0.16], [1, 0], "clamp") }));
  const dockStyle = useAnimatedStyle(() => ({
    opacity: interpolate(frame.get().expansion, [0, 0.4], [1, 0], "clamp"),
    transform: [{ translateY: interpolate(frame.get().expansion, [0, 0.5], [0, 30], "clamp") }],
  }));
  // The library steps back and darkens as the player covers it, and returns as it contracts.
  const libraryStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - frame.get().expansion * 0.06 }] }));
  const shadeStyle = useAnimatedStyle(() => ({ opacity: frame.get().expansion * 0.7 }));
  // Fixed rather than animated: reclipping the swirl's GL surface every frame is what stuttered.
  // Reveal its fixed viewport only near fullscreen; artwork and surface stay continuous underneath.
  const swirlStyle = useAnimatedStyle(() => ({ opacity: interpolate(frame.get().expansion, [0.92, 1], [0, 1], "clamp") }));
  // Sheets push everything back a step, as a card behind them.
  const recedeStyle = useAnimatedStyle(() => {
    const d = Math.min(1, sheetDepth.get());
    return { transform: [{ translateY: d * 10 }, { scale: 1 - d * 0.05 }], opacity: 1 - d * 0.25 };
  });

  // The connection's state is the corner dot's (StatusDot); this is playback's own.
  const shownError = error ?? view?.error;
  const outputs = playingOutputs(view);
  const outputName = outputs.length > 1 ? `${outputs[0].deviceName} + ${outputs.length - 1}` : view?.output?.deviceName;
  const shownArtist = (!expanded && shownError) || (track?.artist ?? (expanded
    ? (view && !view.output ? "Choose an output below" : " ")
    : outputName ?? "Choose an output"));
  const dockHeight = layout.miniBottom + MINI_HEIGHT + 8;
  const coverMenu = (anchor?: { x: number; y: number }) => {
    if (!track) return;
    const run = (work: () => Promise<unknown>, done?: string) => void work().then(() => { if (done) { haptic.success(); showToast(done); } })
      .catch(failure => { haptic.error(); showToast(reason(failure, "Something went wrong. Please try again."), true); });
    openMenu({ anchor, track, actions: [
      // The queue carries desktop's whole song records.
      ...editActions(track as unknown as Parameters<typeof editActions>[0], pushFromPlayer, run),
      { label: lyricsOpen ? "Show Artwork" : "Show Lyrics", icon: "lyrics", run: () => setLyricsOpen(value => !value) },
    ] });
  };
  // Stable, so the memoized pages don't re-render with every session update the player gets.
  const changeServer = useRef(onChangeServer);
  useLayoutEffect(() => { changeServer.current = onChangeServer; });
  const render = useCallback((route: Route) => {
    switch (route.kind) {
      case "home": return <HomeScreen />;
      case "library": return <LibraryScreen />;
      case "search": return <SearchScreen />;
      case "settings": return <SettingsScreen onChangeServer={() => changeServer.current()} />;
      case "section": return <SectionScreen section={route.section} />;
      case "playlist": return <PlaylistScreen id={route.id} provider={route.provider} name={route.name} />;
      case "mix": return <MixScreen provider={route.provider} mix={route.mix} />;
      case "album": return <AlbumScreen album={route.album} />;
      case "artist": return <ArtistScreen artist={route.artist} />;
      case "downloads": return <DownloadsScreen />;
    }
  }, []);
  return (
    <View style={styles.screen}>
      <Animated.View style={[styles.recede, recedeStyle]}>
        <Animated.View style={[styles.library, libraryStyle]} pointerEvents={expanded ? "none" : "auto"} accessibilityElementsHidden={expanded} importantForAccessibility={expanded ? "no-hide-descendants" : "auto"}>
          <BlurTargetView ref={libraryBackdrop} collapsable={false} style={StyleSheet.absoluteFill}>
            <TabPager tab={tab} onTab={setTab} page={page} bottomInset={layout.miniBottom + MINI_HEIGHT} popToRoot={popToRoot} onNavigator={takeNavigator} render={render} />
          </BlurTargetView>
          <Animated.View pointerEvents={expanded ? "none" : "box-none"} style={[styles.dock, { height: dockHeight }, dockStyle]}>
            <DockMask pointerEvents="none" style={StyleSheet.absoluteFill} maskElement={
              <LinearGradient colors={["transparent", "black"]} locations={[(8 + MINI_HEIGHT / 2) / dockHeight, (8 + MINI_HEIGHT) / dockHeight]} style={StyleSheet.absoluteFill} />
            }>
              <BlurView style={StyleSheet.absoluteFill} tint="dark" intensity={65} blurTarget={libraryBackdrop} blurMethod="dimezisBlurViewSdk31Plus" />
              <View style={[StyleSheet.absoluteFill, styles.dockTint]} />
            </DockMask>
            <View style={[styles.navigation, { height: NAVIGATION_HEIGHT + insets.bottom, paddingBottom: insets.bottom + 6 }]}>
              <TabBar labels={tabs} index={tabs.indexOf(tab)} page={page} onSelect={index => setTab(tabs[index])} onReselect={() => setPopToRoot(value => value + 1)} />
            </View>
          </Animated.View>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shade, shadeStyle]} />
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.surface, styles.surfaceBackground, surfaceStyle, backgroundStyle]}>
          {/* Frosted like the dock under it while small; gone well before the player is open. */}
          {!expanded && <Animated.View style={[StyleSheet.absoluteFill, miniStyle]}>
            <BlurView style={StyleSheet.absoluteFill} tint="dark" intensity={55} blurTarget={libraryBackdrop} blurMethod="dimezisBlurViewSdk31Plus" />
          </Animated.View>}
        </Animated.View>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderTopLeftRadius: screenCornerRadius, borderTopRightRadius: screenCornerRadius, overflow: "hidden" }, swirlStyle]}>
          {/* Darkened like the desktop lyrics view, and more behind the white controls. */}
          <Swirl track={track} playing={playing && expanded} darkened />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View collapsable={false} style={[styles.surface, surfaceStyle]} onAccessibilityEscape={expanded ? closePlayer : undefined}>
            {/* Mini-player swipes reveal the neighbouring songs beside it. */}
            {!expanded && <>
              <Ghost track={nextTrack} label="Next" side={1} skip={skipX} width={width - 16} />
              <Ghost track={previousTrack} label="Previous" side={-1} skip={skipX} width={width - 16} />
            </>}
            {expanded && !lyricsOpen && <Animated.View pointerEvents="none" style={[styles.carousel, { top: layout.coverTop }, carouselStyle]}>
              {[previousTrack, nextTrack].map((neighbour, index) => {
                const source = neighbour ? neighbour.fullCover || neighbour.cover : null;
                const scale = playing ? 1 : PAUSED_COVER_SCALE;
                return <View key={index} style={[styles.neighbour, { left: layout.coverLeft + (index ? carouselStep : -carouselStep), width: layout.coverSize, height: layout.coverSize, transform: [{ scale }] }]}>
                  {source ? <Image source={source} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="disk" transition={0} /> : null}
                </View>;
              })}
            </Animated.View>}
            <Animated.View pointerEvents="none" accessibilityElementsHidden={!expanded} importantForAccessibility={expanded ? "auto" : "no-hide-descendants"} style={[styles.cover, { width: layout.coverSize, height: layout.coverSize }, artStyle, !track && styles.coverEmpty]}>
              <AlbumCover track={track} size={layout.coverSize} direction={skipDirection} cornerStyle={artCornerStyle} instant={coverInstant} onShown={coverShown} />
            </Animated.View>
            <Animated.View pointerEvents="none" accessibilityElementsHidden={!expanded} importantForAccessibility={expanded ? "auto" : "no-hide-descendants"} style={[styles.info, { width: textWidth }, textStyle]}>
              <SongText style={styles.title} direction={skipDirection}>{track?.name ?? "Nothing playing"}</SongText>
              <SongText style={[styles.artist, shownError && !expanded && { color: colors.error }]} direction={skipDirection}>{shownArtist}</SongText>
            </Animated.View>
            <Animated.View pointerEvents={expanded && lyricsOpen ? "auto" : "none"} accessibilityElementsHidden={!expanded || !lyricsOpen} importantForAccessibility={expanded && lyricsOpen ? "auto" : "no-hide-descendants"} style={[styles.lyrics, { top: layout.lyricsTop, width, height: layout.lyricsHeight }, lyricsStyle]}>
              {lyricsMounted && <LyricsView key={track?.globalId ?? "empty"} track={track} view={view} active={expanded && lyricsOpen && gesturesEnabled} height={layout.lyricsHeight} disabled={disabled} onSeek={seconds => send("seek", { positionSeconds: seconds })} />}
            </Animated.View>
            <Animated.View pointerEvents={expanded ? "box-none" : "none"} accessibilityElementsHidden={!expanded} importantForAccessibility={expanded ? "auto" : "no-hide-descendants"} style={[styles.details, { width, height }, detailStyle]}>
              {/* The cover itself: tap to play or pause, swipe to skip, hold for the song's menu. */}
              {!lyricsOpen && <GestureDetector gesture={coverGestures}>
                <View collapsable={false} accessible accessibilityRole="button" accessibilityLabel={playing ? "Pause" : "Play"} accessibilityHint="Swipe left or right to skip. Hold for options."
                  onAccessibilityTap={toggle} style={[styles.coverTouch, { left: layout.coverLeft, top: layout.coverTop, width: layout.coverSize, height: layout.coverSize }]} />
              </GestureDetector>}
              <Touchable accessibilityRole="button" accessibilityLabel="Open settings" scale={0.85} onPress={() => pushFromPlayer({ kind: "settings" })} style={[styles.settingsButton, { top: insets.top }]}><Icon name="settings" size={20} color={colors.secondary} /></Touchable>
              <GestureDetector gesture={headerPan}>
                {/* In lyrics, the whole band above them closes the player; the lyrics themselves scroll. */}
                <View collapsable={false} style={lyricsOpen ? [styles.closeBand, { height: layout.lyricsTop, paddingTop: insets.top }] : [styles.collapseGesture, { top: insets.top }]}>
                  <Touchable accessibilityRole="button" accessibilityLabel="Close player" accessibilityHint="You can also swipe down" haptic="tap" scale={0.85} onPress={closePlayer} style={styles.collapse}><View style={styles.grabHandle} /></Touchable>
                </View>
              </GestureDetector>
              <Animated.View style={[styles.progress, { top: layout.progressTop, width: width - 60 }, progressStyle]}>
                <LiveProgress view={view} duration={duration} active={expanded} disabled={disabled} onSeek={seconds => send("seek", { positionSeconds: seconds })} />
              </Animated.View>
              <Animated.View style={[styles.controls, { top: layout.controlsTop, width }, controlsStyle]}>
                <Controls playing={playing} disabled={disabled} onPrevious={() => send("previous")} onToggle={toggle} onNext={() => send("next")} />
              </Animated.View>
              <View style={[styles.footer, { bottom: insets.bottom + 8 }]}>
                <View style={styles.footerText}>
                  <Touchable accessibilityRole="button" accessibilityLabel={`Change audio output, currently ${outputName ?? "none selected"}`} scale={0.92} onPress={() => setOutputOpen(true)} style={styles.outputButton}>
                    <Icon name="output" size={14} color={view?.output ? "white" : colors.muted} />
                    <Text style={[styles.output, !view?.output && { color: colors.muted }]} numberOfLines={1}>{outputName ?? "Choose an output"}</Text>
                  </Touchable>
                  {shownError && <Text accessibilityRole="alert" numberOfLines={2} style={styles.error}>{shownError}</Text>}
                </View>
                <Touchable accessibilityRole="button" accessibilityLabel={lyricsOpen ? "Show artwork" : "Show lyrics"} accessibilityState={{ selected: lyricsOpen }} disabled={!track} scale={0.85} onPress={() => setLyricsOpen(value => !value)} style={[styles.footerButton, lyricsOpen && styles.lyricsSelected]}><Icon name="lyrics" size={22} /></Touchable>
                <Touchable accessibilityRole="button" accessibilityLabel="Open queue" accessibilityHint="Or pull the player up" scale={0.85} onPress={openQueue} style={styles.footerButton}><Icon name="queue" size={22} /></Touchable>
              </View>
            </Animated.View>
            <Animated.View pointerEvents="none" style={[styles.pullHint, { bottom: insets.bottom + 70 }, pullHintStyle]}>
              <Icon name="queue" size={14} />
              <Text style={styles.pullHintText}>Release for Up Next{nextTrack ? `: ${nextTrack.name}` : ""}</Text>
            </Animated.View>
            <Animated.View pointerEvents={expanded ? "none" : "box-none"} accessibilityElementsHidden={expanded} importantForAccessibility={expanded ? "no-hide-descendants" : "auto"} style={[styles.mini, miniStyle]}>
              <GestureDetector gesture={miniSkip}>
                <View collapsable={false} style={styles.miniTrack}>
                  <Touchable accessibilityRole="button" accessibilityLabel={`Open player${track ? `: ${track.name}, ${track.artist}` : ""}`} accessibilityHint="Swipe up to open, sideways to skip" scale={0.98} haptic="soft" onPress={openPlayer} style={StyleSheet.absoluteFill}><View /></Touchable>
                </View>
              </GestureDetector>
              <Touchable accessibilityRole="button" accessibilityLabel={`Change audio output, currently ${outputName ?? "none selected"}`} haptic="select" scale={0.8} onPress={() => setOutputOpen(true)} style={styles.miniButton}><Icon name="output" size={19} color={view?.output ? colors.secondary : colors.muted} /></Touchable>
              <PlayPauseButton playing={playing} disabled={disabled} size={24} onToggle={toggle} />
              <MiniProgress view={view} duration={duration} shown={!expanded} />
            </Animated.View>
          </Animated.View>
        </GestureDetector>
      </Animated.View>
      {queueOpen && <QueueSheet view={view} onClose={closeQueue} />}
      {outputOpen && <OutputPicker view={view} onClose={closeOutput} />}
      <SheetHosts />
      <ContextMenuHost />
      <ToastHost bottom={expanded ? insets.bottom + 72 : dockHeight + 8} />
      <StatusDot message={connectionError} offline={offlineActive()} hidden={expanded} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, overflow: "hidden", backgroundColor: colors.black },
  recede: { flex: 1, overflow: "hidden", borderCurve: "continuous", backgroundColor: colors.black },
  library: { flex: 1, overflow: "hidden", borderCurve: "continuous" },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0, overflow: "hidden" },
  dockTint: { backgroundColor: "rgba(0, 0, 0, 0.45)" },
  navigation: { position: "absolute", left: 0, right: 0, bottom: 0, justifyContent: "flex-end", paddingHorizontal: 20 },
  settingsButton: { position: "absolute", right: 14, width: 44, height: 44, alignItems: "center", justifyContent: "center", zIndex: 3 },
  shade: { backgroundColor: colors.black },
  surface: { position: "absolute", overflow: "hidden", borderCurve: "continuous" },
  surfaceBackground: { borderWidth: StyleSheet.hairlineWidth },
  collapseGesture: { position: "absolute", alignSelf: "center", height: 44, width: 72, zIndex: 2 },
  closeBand: { position: "absolute", left: 0, right: 0, top: 0, alignItems: "center", zIndex: 2 },
  collapse: { height: 44, width: 72, alignItems: "center", justifyContent: "center" },
  coverTouch: { position: "absolute" },
  lyrics: { position: "absolute", left: 0 },
  lyricsSelected: { backgroundColor: "rgba(255,255,255,0.12)", borderRadius: radius.md },
  grabHandle: { width: 36, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.4)" },
  footer: { position: "absolute", left: 20, right: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  footerText: { flex: 1, alignItems: "flex-start" },
  outputButton: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 36, maxWidth: "100%", paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: "rgba(255, 255, 255, 0.08)" },
  footerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  output: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: textSize.caption, fontWeight: "600" },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: textSize.caption, lineHeight: 18, marginTop: 4, paddingHorizontal: 4 },
  pullHint: { position: "absolute", alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "80%", paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill, backgroundColor: "rgba(0, 0, 0, 0.6)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255, 255, 255, 0.15)" },
  pullHintText: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.detail, fontWeight: "600", flexShrink: 1 },
  mini: { position: "absolute", left: 0, right: 0, top: 0, height: MINI_HEIGHT, flexDirection: "row", alignItems: "center", paddingRight: 4 },
  miniTrack: { flex: 1, height: MINI_HEIGHT },
  miniButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  miniProgress: { position: "absolute", left: 16, right: 16, bottom: 0, height: 2, borderRadius: 1, overflow: "hidden", backgroundColor: "rgba(255, 255, 255, 0.1)" },
  miniFill: { height: 2, backgroundColor: "rgba(255, 255, 255, 0.8)", transformOrigin: "left" },
  ghost: { position: "absolute", left: 10, right: 96, top: 10, height: 44, flexDirection: "row", alignItems: "center", gap: 12 },
  ghostText: { flex: 1, gap: 2 },
  ghostLabel: { color: colors.accent, fontFamily: fonts.sans, fontSize: 10, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" },
  ghostTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 14, fontWeight: "600" },
  cover: { position: "absolute", left: 0, top: 0, transformOrigin: "top left", zIndex: 1 },
  carousel: { position: "absolute", left: 0, right: 0, height: 1, overflow: "visible" },
  neighbour: { position: "absolute", top: 0, borderRadius: 15, borderCurve: "continuous", overflow: "hidden", backgroundColor: "rgba(255, 255, 255, 0.06)" },
  coverEmpty: { shadowColor: "white", shadowOpacity: 0.18, shadowRadius: 30, shadowOffset: { width: 0, height: 0 } },
  info: { position: "absolute", left: 0, top: 0, transformOrigin: "top left" },
  title: { color: colors.text, fontFamily: fonts.sans, fontWeight: "700", letterSpacing: -0.3, fontSize: 19, lineHeight: 24 },
  artist: { color: "rgba(255, 255, 255, 0.75)", fontFamily: fonts.sans, fontSize: 16, lineHeight: 20, marginTop: 6 },
  details: { position: "absolute", left: 0, top: 0 },
  progress: { position: "absolute", left: 30 },
  controls: { position: "absolute", left: 0 },
});
