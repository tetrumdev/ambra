import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
  type ComponentType,
  type ReactElement,
} from "react";
import { BackHandler, StyleSheet, Text, View, useWindowDimensions, type ViewProps, type TextStyle } from "react-native";
import { BlurTargetView, BlurView } from "expo-blur";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  command,
  currentTrack,
  sessionView,
  sessionViewAge,
  subscribe,
  type SessionView,
} from "./client";
import { Controls } from "./Controls";
import { AlbumCover } from "./AlbumCover";
import { LyricsView } from "./LyricsView";
import { playerTiming } from "./playerMotion";
import { Progress } from "./Progress";
import { SongText } from "./SongText";
import { Swirl, type CoverFrame } from "./Swirl";
import { Icon } from "./Icons";
import { PlaylistBrowser, QueueSheet } from "./TrackBrowser";
import { OutputPicker } from "./OutputPicker";
import { colors, fonts, haptic } from "./theme";
import { Touchable } from "./Touchable";
import { MINI_HEIGHT, NAVIGATION_HEIGHT, playerFrame, playerLayout } from "./playerGeometry";

const PAUSED_COVER_SCALE = 0.9;
const coverSpring = { damping: 16, stiffness: 140, mass: 1 };
/** Opening and closing the player: quick, settled, never bouncing past the screen's edge. */
const sheetSpring = { damping: 34, stiffness: 300, mass: 1, overshootClamping: true };
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

/** The mini-player's line runs on the UI thread from each report to the song's end. */
function MiniProgress({ view, duration }: { view: SessionView | null; duration: number }) {
  const fill = useSharedValue(0);
  useEffect(() => {
    if (!view || duration <= 0) { fill.set(0); return; }
    const playing = view.playing && !view.buffering;
    const now = Math.min(1, (view.positionSeconds + (playing ? sessionViewAge() : 0)) / duration);
    fill.set(now);
    if (playing && now < 1) fill.set(withTiming(1, { duration: (1 - now) * duration * 1000, easing: Easing.linear }));
  }, [view, duration, fill]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.get() }] }));
  return <View style={styles.miniProgress}><Animated.View style={[styles.miniFill, style]} /></View>;
}

export function Player({ connectionError = null }: { connectionError?: string | null }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const layout = playerLayout(width, height, insets.top, insets.bottom);
  const [expanded, setExpanded] = useState(true);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const lyricsMode = useSharedValue(0);
  useEffect(() => { lyricsMode.set(withTiming(lyricsOpen ? 1 : 0, playerTiming)); }, [lyricsOpen, lyricsMode]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const [trackMenuOpen, setTrackMenuOpen] = useState(false);
  const libraryBackdrop = useRef<ComponentRef<typeof View>>(null);
  const [error, setError] = useState<string | null>(null);
  // A normalized value preserves either endpoint when screen dimensions or safe areas change.
  const expansion = useSharedValue(1);
  const expandedNow = useRef(true);
  const settle = useCallback((open: boolean, velocity = 0) => {
    expandedNow.current = open;
    setExpanded(open);
    expansion.set(withSpring(open ? 1 : 0, { ...sheetSpring, velocity }));
  }, [expansion]);
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

  // Touch callbacks stay on RN; springs still animate on the UI thread after release.
  const drag = useRef({ start: 1, passed: false });
  const travel = Math.max(1, layout.miniTop);
  const threshold = Math.min(120, travel * 0.18);
  const panCallbacks = {
    runOnJS: true,
    activeOffsetY: [-12, 12] as [number, number],
    failOffsetX: [-20, 20] as [number, number],
    onActivate: () => {
      cancelAnimation(expansion);
      drag.current = { start: expansion.get(), passed: false };
    },
    onUpdate: (event: { translationY: number }) => {
      expansion.set(Math.min(1, Math.max(0, drag.current.start - event.translationY / travel)));
      const past = Math.abs(event.translationY) > threshold;
      if (past !== drag.current.passed) {
        drag.current.passed = past;
        if (past) haptic.select();
      }
    },
    onDeactivate: (event: { translationY: number; velocityY: number; canceled: boolean }) => {
      if (event.canceled) { settle(expandedNow.current); return; }
      const current = expansion.get();
      const projected = current - event.velocityY / travel * 0.18;
      const moved = Math.abs(event.translationY) > threshold;
      const open = event.velocityY < -600 ? true
        : event.velocityY > 850 ? false
        : moved ? event.translationY < 0 : projected >= 0.5;
      if (open !== expandedNow.current) haptic.tap();
      settle(open, -event.velocityY / travel);
    },
    onFinalize: (event: { canceled: boolean }) => {
      if (event.canceled) settle(expandedNow.current);
    },
  };
  const gesturesEnabled = !queueOpen && !outputOpen && !trackMenuOpen;
  // The Worklets Babel plugin cannot transform spreads in gesture-hook objects.
  const pan = usePanGesture({
    runOnJS: true,
    enabled: gesturesEnabled && !(lyricsOpen && expanded),
    activeOffsetY: panCallbacks.activeOffsetY,
    failOffsetX: panCallbacks.failOffsetX,
    onActivate: panCallbacks.onActivate,
    onUpdate: panCallbacks.onUpdate,
    onDeactivate: panCallbacks.onDeactivate,
    onFinalize: panCallbacks.onFinalize,
  });
  const headerPan = usePanGesture({
    runOnJS: true,
    enabled: gesturesEnabled && lyricsOpen && expanded,
    activeOffsetY: panCallbacks.activeOffsetY,
    failOffsetX: panCallbacks.failOffsetX,
    onActivate: panCallbacks.onActivate,
    onUpdate: panCallbacks.onUpdate,
    onDeactivate: panCallbacks.onDeactivate,
    onFinalize: panCallbacks.onFinalize,
  });

  const skip = useRef({ direction: 1, at: 0 });
  const skipDirection = useCallback(
    () => (Date.now() - skip.current.at < 3000 ? skip.current.direction : 1),
    [],
  );
  const view = useSyncExternalStore(subscribe, sessionView);
  const track = currentTrack(view);
  // Shown at once, until the session moves on with the server's answer.
  const [wanted, setWanted] = useState<{ playing: boolean; revision: number } | null>(null);
  const revision = view?.revision ?? 0;
  const playing = wanted?.revision === revision ? wanted.playing : (view?.playing ?? false);
  const duration = view?.duration || track?.durationSeconds || 0;
  const disabled = !track || !view?.output;
  const send = (action: string, details?: Record<string, unknown>) => {
    if (action === "previous" || action === "next") skip.current = { direction: action === "previous" ? -1 : 1, at: Date.now() };
    setError(null);
    void command(action, details).catch(reason => {
      setWanted(null);
      haptic.error();
      setError(reason instanceof Error ? reason.message : "Couldn't update playback. Please try again.");
    });
  };
  const toggle = () => {
    setWanted({ playing: !playing, revision });
    send(playing ? "pause" : "play");
  };

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
    const radius = 18 + (screenCornerRadius - 18) * f.expansion;
    return {
      left: f.left, top: f.top, width: f.width, height: f.height,
      borderTopLeftRadius: radius, borderTopRightRadius: radius,
      borderBottomLeftRadius: 18 * (1 - f.expansion), borderBottomRightRadius: 18 * (1 - f.expansion),
    };
  });
  const backgroundStyle = useAnimatedStyle(() => {
    const p = frame.get().expansion;
    const gray = 24 * (1 - p);
    return { backgroundColor: `rgb(${gray}, ${gray}, ${gray})`, borderColor: `rgba(255, 255, 255, ${0.08 * (1 - p)})` };
  });
  const artStyle = useAnimatedStyle(() => {
    const f = frame.get();
    return { left: f.artLeft, top: f.artTop, transform: [{ scale: f.artScale }] };
  });
  const artCornerStyle = useAnimatedStyle(() => {
    const f = frame.get();
    return { borderRadius: f.artRadius / f.artScale };
  });
  const textStyle = useAnimatedStyle(() => {
    const f = frame.get();
    return { left: f.textLeft, top: f.textTop, width: f.textWidth, opacity: f.textOpacity };
  });
  const titleStyle = useAnimatedStyle<TextStyle>(() => ({ fontSize: frame.get().textHeader ? 16 : frame.get().textExpanded ? 19 : 14, lineHeight: frame.get().textHeader ? 20 : frame.get().textExpanded ? 24 : 18 }));
  const artistStyle = useAnimatedStyle<TextStyle>(() => ({ fontSize: frame.get().textHeader ? 13 : frame.get().textExpanded ? 16 : 12, lineHeight: frame.get().textHeader ? 17 : frame.get().textExpanded ? 20 : 15, marginTop: frame.get().textHeader ? 4 : frame.get().textExpanded ? 6 : 3 }));
  const detailStyle = useAnimatedStyle(() => ({
    opacity: interpolate(frame.get().expansion, [0.35, 0.85], [0, 1], "clamp"),
    transform: [{ translateY: 24 * (1 - frame.get().expansion) }],
  }));
  const lyricsStyle = useAnimatedStyle(() => ({ opacity: interpolate(expansion.get(), [0.7, 1], [0, 1], "clamp") * interpolate(lyricsMode.get(), [0.35, 1], [0, 1], "clamp") }));
  const progressStyle = useAnimatedStyle(() => ({ top: layout.progressTop + (layout.lyricsProgressTop - layout.progressTop) * lyricsMode.get() }));
  const controlsStyle = useAnimatedStyle(() => ({ top: layout.controlsTop + (layout.lyricsControlsTop - layout.controlsTop) * lyricsMode.get() }));
  const miniStyle = useAnimatedStyle(() => ({ opacity: interpolate(frame.get().expansion, [0, 0.16], [1, 0], "clamp") }));
  const dockStyle = useAnimatedStyle(() => ({ opacity: trackMenuOpen ? 0 : interpolate(frame.get().expansion, [0, 0.4], [1, 0], "clamp") }));
  // The library darkens as the player covers it, and brightens as it contracts.
  const shadeStyle = useAnimatedStyle(() => ({ opacity: frame.get().expansion * 0.7 }));
  // Fixed rather than animated: reclipping the swirl's GL surface every frame is what stuttered.
  // Reveal its fixed viewport only near fullscreen; artwork and surface stay continuous underneath.
  const swirlStyle = useAnimatedStyle(() => ({ opacity: interpolate(frame.get().expansion, [0.92, 1], [0, 1], "clamp") }));
  const coverFrame = useRef<CoverFrame | null>(null);
  useEffect(() => {
    const size = lyricsOpen ? 56 : layout.coverSize * (playing ? 1 : PAUSED_COVER_SCALE);
    coverFrame.current = { x: lyricsOpen ? 30 : (width - size) / 2, y: lyricsOpen ? layout.coverTop : layout.coverTop + (layout.coverSize - size) / 2, size };
  }, [layout.coverSize, layout.coverTop, width, playing, lyricsOpen]);

  const shownError = error ?? view?.error ?? connectionError;
  const shownArtist = (!expanded && shownError) || (track?.artist ?? (expanded
    ? (view && !view.output ? "Choose an output below" : " ")
    : view?.output?.deviceName ?? "Choose an output"));
  const hiddenByMenu = trackMenuOpen && !expanded;
  const dockHeight = layout.miniBottom + MINI_HEIGHT + 8;
  return (
    <View style={styles.screen}>
      <View style={styles.library} pointerEvents={expanded ? "none" : "auto"} accessibilityElementsHidden={expanded} importantForAccessibility={expanded ? "no-hide-descendants" : "auto"}>
        <BlurTargetView ref={libraryBackdrop} collapsable={false} style={StyleSheet.absoluteFill}>
          <PlaylistBrowser view={view} bottomInset={layout.miniBottom + MINI_HEIGHT} onMenuVisibilityChange={setTrackMenuOpen} />
        </BlurTargetView>
        {/* Keep native blur and touch targets mounted while a long press opens a menu. */}
        <Animated.View pointerEvents={trackMenuOpen || expanded ? "none" : "auto"} accessibilityElementsHidden={trackMenuOpen || expanded} importantForAccessibility={trackMenuOpen || expanded ? "no-hide-descendants" : "auto"} style={[styles.dock, { height: dockHeight }, dockStyle, trackMenuOpen && styles.hidden]}>
          <DockMask pointerEvents="none" style={StyleSheet.absoluteFill} maskElement={
            <LinearGradient colors={["transparent", "black"]} locations={[(8 + MINI_HEIGHT / 2) / dockHeight, (8 + MINI_HEIGHT) / dockHeight]} style={StyleSheet.absoluteFill} />
          }>
            <BlurView style={StyleSheet.absoluteFill} tint="dark" intensity={65} blurTarget={libraryBackdrop} blurMethod="dimezisBlurViewSdk31Plus" />
            <View style={[StyleSheet.absoluteFill, styles.dockTint]} />
          </DockMask>
          <View style={[styles.navigation, { height: NAVIGATION_HEIGHT + insets.bottom, paddingBottom: insets.bottom }]}>
            <Text style={styles.navigationLabel}>Home</Text>
            <Text style={styles.navigationLabel}>Search</Text>
            <Text style={[styles.navigationLabel, styles.navigationSelected]} accessibilityState={{ selected: true }}>Library</Text>
          </View>
        </Animated.View>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shade, shadeStyle]} />
      </View>
      <Animated.View pointerEvents="none" style={[styles.surface, styles.surfaceBackground, surfaceStyle, backgroundStyle, hiddenByMenu && styles.hidden]} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderTopLeftRadius: screenCornerRadius, borderTopRightRadius: screenCornerRadius, overflow: "hidden" }, swirlStyle]}>
        {/* Darkened like the desktop lyrics view, and more behind the white controls. */}
        <Swirl track={track} playing={playing && expanded} cover={coverFrame} darkened />
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View collapsable={false} style={[styles.surface, surfaceStyle, hiddenByMenu && styles.hidden]} pointerEvents={hiddenByMenu ? "none" : "auto"} accessibilityElementsHidden={hiddenByMenu} importantForAccessibility={hiddenByMenu ? "no-hide-descendants" : "auto"} onAccessibilityEscape={expanded ? closePlayer : undefined}>
          <Animated.View pointerEvents="none" accessibilityElementsHidden={!expanded} importantForAccessibility={expanded ? "auto" : "no-hide-descendants"} style={[styles.cover, { width: layout.coverSize, height: layout.coverSize }, artStyle, !track && styles.coverEmpty]}>
            <AlbumCover track={track} size={layout.coverSize} direction={skipDirection} cornerStyle={artCornerStyle} />
          </Animated.View>
          <Animated.View pointerEvents="none" accessibilityElementsHidden={!expanded} importantForAccessibility={expanded ? "auto" : "no-hide-descendants"} style={[styles.info, textStyle]}>
            <SongText style={[styles.title, titleStyle]} direction={skipDirection}>{track?.name ?? "Nothing playing"}</SongText>
            <SongText style={[styles.artist, artistStyle, shownError && !expanded && { color: colors.error }]} direction={skipDirection}>{shownArtist}</SongText>
          </Animated.View>
          <Animated.View pointerEvents={expanded && lyricsOpen ? "auto" : "none"} accessibilityElementsHidden={!expanded || !lyricsOpen} importantForAccessibility={expanded && lyricsOpen ? "auto" : "no-hide-descendants"} style={[styles.lyrics, { top: layout.lyricsTop, width, height: layout.lyricsHeight }, lyricsStyle]}>
            <LyricsView key={track?.globalId ?? "empty"} track={track} view={view} active={expanded && lyricsOpen && gesturesEnabled} height={layout.lyricsHeight} disabled={disabled} onSeek={seconds => send("seek", { positionSeconds: seconds })} />
          </Animated.View>
          <Animated.View pointerEvents={expanded ? "box-none" : "none"} accessibilityElementsHidden={!expanded} importantForAccessibility={expanded ? "auto" : "no-hide-descendants"} style={[styles.details, { width, height }, detailStyle]}>
            <GestureDetector gesture={headerPan}>
              <View collapsable={false} style={[styles.collapseGesture, { top: insets.top }]}>
                <Touchable accessibilityRole="button" accessibilityLabel="Close player" accessibilityHint="You can also swipe down here" haptic="tap" scale={0.9} onPress={closePlayer} style={styles.collapse}><View style={styles.grabHandle} /></Touchable>
              </View>
            </GestureDetector>
            <Animated.View style={[styles.progress, { width: width - 60 }, progressStyle]}>
              <LiveProgress view={view} duration={duration} active={expanded} disabled={disabled} onSeek={seconds => send("seek", { positionSeconds: seconds })} />
            </Animated.View>
            <Animated.View style={[styles.controls, { width }, controlsStyle]}>
              <Controls playing={playing} disabled={disabled} onPrevious={() => send("previous")} onToggle={toggle} onNext={() => send("next")} />
            </Animated.View>
            <View style={[styles.footer, { bottom: insets.bottom + 8 }]}>
              <View style={styles.footerText}>
                <Touchable accessibilityRole="button" accessibilityLabel={`Change audio output, currently ${view?.output?.deviceName ?? "none selected"}`} scale={0.94} onPress={() => setOutputOpen(true)} style={styles.outputButton}>
                  <Icon name="output" size={14} color={view?.output ? "white" : colors.muted} />
                  <Text style={[styles.output, !view?.output && { color: colors.muted }]} numberOfLines={1}>{view?.output?.deviceName ?? "Choose an output"}</Text>
                </Touchable>
                {shownError && <Text accessibilityRole="alert" numberOfLines={2} style={styles.error}>{shownError}</Text>}
              </View>
              <Touchable accessibilityRole="button" accessibilityLabel={lyricsOpen ? "Show artwork" : "Show lyrics"} accessibilityState={{ selected: lyricsOpen }} disabled={!track} scale={0.9} onPress={() => setLyricsOpen(value => !value)} style={[styles.footerButton, lyricsOpen && styles.lyricsSelected]}><Icon name="lyrics" size={22} /></Touchable>
              <Touchable accessibilityRole="button" accessibilityLabel="Open queue" scale={0.85} onPress={openQueue} style={styles.footerButton}><Icon name="queue" size={22} /></Touchable>
            </View>
          </Animated.View>
          <Animated.View pointerEvents={expanded ? "none" : "box-none"} accessibilityElementsHidden={expanded} importantForAccessibility={expanded ? "no-hide-descendants" : "auto"} style={[styles.mini, miniStyle]}>
            <Touchable accessibilityRole="button" accessibilityLabel={`Open player${track ? `: ${track.name}, ${track.artist}` : ""}`} accessibilityHint="Or swipe up" scale={1} onPress={openPlayer} style={styles.miniTrack}><View /></Touchable>
            <Touchable accessibilityRole="button" accessibilityLabel={playing ? "Pause" : "Play"} disabled={disabled} haptic="firm" hapticOnPressIn scale={0.85} onPress={toggle} style={styles.miniButton}><Icon name={playing ? "pause" : "play"} size={20} /></Touchable>
            <Touchable accessibilityRole="button" accessibilityLabel="Next track" disabled={disabled} haptic="firm" hapticOnPressIn scale={0.85} onPress={() => send("next")} style={styles.miniButton}><Icon name="skip" size={20} /></Touchable>
            <MiniProgress view={view} duration={duration} />
          </Animated.View>
        </Animated.View>
      </GestureDetector>
      {queueOpen && <QueueSheet view={view} onClose={closeQueue} onMenuVisibilityChange={setTrackMenuOpen} />}
      {outputOpen && <OutputPicker view={view} onClose={closeOutput} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, overflow: "hidden", backgroundColor: colors.black },
  library: { flex: 1 },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0, overflow: "hidden" },
  hidden: { opacity: 0 },
  dockTint: { backgroundColor: "rgba(18, 18, 18, 0.35)" },
  navigation: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", alignItems: "center" },
  navigationLabel: { flex: 1, textAlign: "center", color: colors.muted, fontFamily: fonts.sans, fontSize: 14, fontWeight: "500" },
  navigationSelected: { color: "white", fontWeight: "600" },
  shade: { backgroundColor: colors.black },
  surface: { position: "absolute", overflow: "hidden", borderCurve: "continuous" },
  surfaceBackground: { borderWidth: StyleSheet.hairlineWidth },
  collapseGesture: { position: "absolute", alignSelf: "center", height: 44, width: 72, zIndex: 2 },
  collapse: { height: 44, width: 72, alignItems: "center", justifyContent: "center" },
  lyrics: { position: "absolute", left: 0 },
  lyricsSelected: { backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 12 },
  grabHandle: { width: 36, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.4)" },
  footer: { position: "absolute", left: 20, right: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  footerText: { flex: 1, alignItems: "flex-start" },
  outputButton: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, maxWidth: "100%", paddingHorizontal: 12, borderRadius: 100, backgroundColor: "rgba(255, 255, 255, 0.08)" },
  footerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  output: { flexShrink: 1, color: "white", fontFamily: fonts.sans, fontSize: 12, fontWeight: "600" },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: 4, paddingHorizontal: 4 },
  mini: { position: "absolute", left: 0, right: 0, top: 0, height: MINI_HEIGHT, flexDirection: "row", alignItems: "center", paddingRight: 4 },
  miniTrack: { flex: 1, height: MINI_HEIGHT },
  miniButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  miniProgress: { position: "absolute", left: 16, right: 16, bottom: 0, height: 2, borderRadius: 1, overflow: "hidden", backgroundColor: "rgba(255, 255, 255, 0.1)" },
  miniFill: { height: 2, backgroundColor: "rgba(255, 255, 255, 0.8)", transformOrigin: "left" },
  cover: { position: "absolute", transformOrigin: "top left", zIndex: 1 },
  coverEmpty: { shadowColor: "white", shadowOpacity: 0.18, shadowRadius: 30, shadowOffset: { width: 0, height: 0 } },
  info: { position: "absolute" },
  title: { color: "white", fontFamily: fonts.sans, fontWeight: "700", letterSpacing: -0.3 },
  artist: { color: "rgba(255, 255, 255, 0.75)", fontFamily: fonts.sans },
  details: { position: "absolute", left: 0, top: 0 },
  progress: { position: "absolute", left: 30 },
  controls: { position: "absolute", left: 0 },
});
