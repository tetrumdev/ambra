import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
} from "react";
import { BackHandler, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
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
import { Artwork } from "./Artwork";
import { Progress } from "./Progress";
import { SongText } from "./SongText";
import { Swirl, type CoverFrame } from "./Swirl";
import { Icon } from "./Icons";
import { PlaylistBrowser, QueueSheet } from "./TrackBrowser";
import { OutputPicker } from "./OutputPicker";
import { colors, fonts, haptic } from "./theme";
import { Touchable } from "./Touchable";

const PAUSED_COVER_SCALE = 0.9;
const coverSpring = { damping: 16, stiffness: 140, mass: 1 };
/** Opening and closing the player: quick, settled, never bouncing past the screen's edge. */
const sheetSpring = { damping: 34, stiffness: 300, mass: 1, overshootClamping: true };
const MINI_HEIGHT = 64;

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

export function Player() {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [expanded, setExpanded] = useState(true);
  const [queueOpen, setQueueOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 0 is open; `height` is tucked away below the mini-player.
  const slide = useSharedValue(0);
  const passed = useSharedValue(false);
  const openPlayer = useCallback(() => {
    setExpanded(true);
    slide.set(withSpring(0, sheetSpring));
  }, [slide]);
  const closePlayer = useCallback(() => {
    setExpanded(false);
    slide.set(withSpring(height, sheetSpring));
  }, [slide, height]);
  const openQueue = useCallback(() => setQueueOpen(true), []);
  const closeQueue = useCallback(() => setQueueOpen(false), []);
  const closeOutput = useCallback(() => setOutputOpen(false), []);
  // A closed player follows the screen's height; opening and closing animate themselves.
  const expandedNow = useRef(expanded);
  useEffect(() => { expandedNow.current = expanded; }, [expanded]);
  useEffect(() => {
    if (!expandedNow.current) slide.set(height);
  }, [height, slide]);
  useEffect(() => {
    if (!expanded) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => { closePlayer(); return true; });
    return () => back.remove();
  }, [expanded, closePlayer]);

  // Both drags run on the UI thread and hand off their own velocity, so the player never waits on JS.
  const closeAt = Math.min(140, height * 0.18);
  const dismiss = usePanGesture({
    enabled: expanded,
    activeOffsetY: 12,
    failOffsetX: [-20, 20],
    onUpdate: event => {
      "worklet";
      const y = Math.max(0, event.translationY);
      slide.set(y);
      const past = y > closeAt;
      if (past !== passed.get()) {
        passed.set(past);
        if (past) scheduleOnRN(haptic.select);
      }
    },
    onDeactivate: event => {
      "worklet";
      passed.set(false);
      const close = !event.canceled && (event.translationY > closeAt || (event.translationY > 30 && event.velocityY > 850));
      slide.set(withSpring(close ? height : 0, { ...sheetSpring, velocity: event.velocityY }));
      if (close) scheduleOnRN(setExpanded, false);
    },
    onFinalize: event => {
      "worklet";
      if (event.canceled) slide.set(withSpring(0, sheetSpring));
    },
  });
  const raise = usePanGesture({
    enabled: !expanded,
    activeOffsetY: [-10, 10],
    failOffsetX: [-20, 20],
    onUpdate: event => {
      "worklet";
      slide.set(Math.min(height, Math.max(0, height + event.translationY)));
    },
    onDeactivate: event => {
      "worklet";
      const open = !event.canceled && (event.translationY < -80 || event.velocityY < -600);
      slide.set(withSpring(open ? 0 : height, { ...sheetSpring, velocity: event.velocityY }));
      if (open) {
        scheduleOnRN(setExpanded, true);
        scheduleOnRN(haptic.tap);
      }
    },
  });
  // Safe-area geometry gives a device-scaled estimate; RN exposes no physical screen radius.
  // Fixed rather than animated: reclipping the swirl's GL surface every frame is what stuttered.
  const screenCornerRadius = Math.min(56, Math.max(24, insets.top));
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: slide.get() }] }));
  // The library darkens as the player covers it, and brightens as it slides away.
  const shadeStyle = useAnimatedStyle(() => ({ opacity: interpolate(slide.get(), [0, height], [1, 0], "clamp") }));

  const skip = useRef({ direction: 1, at: 0 });
  const skipDirection = useCallback(
    () => (Date.now() - skip.current.at < 3000 ? skip.current.direction : 1),
    [],
  );
  const view = useSyncExternalStore(subscribe, sessionView);
  const track = currentTrack(view);
  // Shown at once, until the session moves on with the server's answer.
  const [wanted, setWanted] = useState<{
    playing: boolean;
    revision: number;
  } | null>(null);
  const revision = view?.revision ?? 0;
  const playing =
    wanted?.revision === revision ? wanted.playing : (view?.playing ?? false);
  const duration = view?.duration || track?.durationSeconds || 0;
  const disabled = !track || !view?.output;

  const send = (action: string, details?: Record<string, unknown>) => {
    if (action === "previous" || action === "next")
      skip.current = {
        direction: action === "previous" ? -1 : 1,
        at: Date.now(),
      };
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

  // Like Apple Music, the cover steps back while paused.
  const coverScale = useSharedValue(playing ? 1 : PAUSED_COVER_SCALE);
  useEffect(() => {
    coverScale.set(withSpring(playing ? 1 : PAUSED_COVER_SCALE, coverSpring));
  }, [playing, coverScale]);
  const coverStyle = useAnimatedStyle(() => ({
    transform: [{ scale: coverScale.get() }],
  }));

  const coverView = useRef<ComponentRef<typeof View>>(null);
  const measured = useRef<CoverFrame | null>(null);
  const coverFrame = useRef<CoverFrame | null>(null);
  const placeCover = () => {
    const frame = measured.current;
    if (!frame) return;
    const size = frame.size * (playing ? 1 : PAUSED_COVER_SCALE);
    coverFrame.current = {
      x: frame.x + (frame.size - size) / 2,
      y: frame.y + (frame.size - size) / 2,
      size,
    };
  };
  useEffect(placeCover, [playing]);

  const shownError = error ?? view?.error;
  const miniBottom = insets.bottom + 8;
  return (
    <View style={styles.screen}>
      <View style={styles.library} accessibilityElementsHidden={expanded} importantForAccessibility={expanded ? "no-hide-descendants" : "auto"}>
        <PlaylistBrowser view={view} bottomInset={miniBottom + MINI_HEIGHT} />
        <GestureDetector gesture={raise}>
          <View style={[styles.mini, { bottom: miniBottom }]}>
            <Touchable accessibilityRole="button" accessibilityLabel={`Open player${track ? `: ${track.name}, ${track.artist}` : ""}`} accessibilityHint="Or swipe up" scale={0.98} onPress={openPlayer} style={styles.miniTrack}>
              <Artwork track={track} size={44} />
              <View style={styles.miniText}>
                <Text numberOfLines={1} style={styles.miniTitle}>{track?.name ?? "Nothing playing"}</Text>
                <Text numberOfLines={1} style={[styles.miniArtist, shownError && !expanded && { color: colors.error }]}>{(!expanded && shownError) || (track?.artist ?? view?.output?.deviceName ?? "Choose an output")}</Text>
              </View>
            </Touchable>
            <Touchable accessibilityRole="button" accessibilityLabel={playing ? "Pause" : "Play"} disabled={disabled} haptic="firm" hapticOnPressIn scale={0.85} onPress={toggle} style={styles.miniButton}><Icon name={playing ? "pause" : "play"} size={20} /></Touchable>
            <Touchable accessibilityRole="button" accessibilityLabel="Open queue" scale={0.85} onPress={openQueue} style={styles.miniButton}><Icon name="queue" size={21} /></Touchable>
            <MiniProgress view={view} duration={duration} />
          </View>
        </GestureDetector>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shade, shadeStyle]} />
      </View>
      <GestureDetector gesture={dismiss}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.fullscreen, { borderTopLeftRadius: screenCornerRadius, borderTopRightRadius: screenCornerRadius }, sheetStyle]} pointerEvents={expanded ? "auto" : "none"} accessibilityElementsHidden={!expanded} importantForAccessibility={expanded ? "auto" : "no-hide-descendants"} onAccessibilityEscape={closePlayer}>
      {/* Darkened like the desktop lyrics view, and more behind the white controls. */}
      <Swirl track={track} playing={playing && expanded} cover={coverFrame} darkened />
      <Touchable accessibilityRole="button" accessibilityLabel="Close player" accessibilityHint="You can also swipe down" haptic="tap" scale={0.9} onPress={closePlayer} style={[styles.collapse, { top: insets.top }]}><View style={styles.grabHandle} /></Touchable>
      <View
        style={[
          styles.content,
          { paddingTop: insets.top + 44, paddingBottom: insets.bottom + 12 },
        ]}
      >
        <View
          ref={coverView}
          style={styles.coverSlot}
          onLayout={() =>
            coverView.current?.measureInWindow((x, y, width) => {
              measured.current = { x, y, size: width };
              placeCover();
            })
          }
        >
          <Animated.View
            style={[styles.cover, coverStyle, !track && styles.coverEmpty]}
          >
            <AlbumCover
              track={track}
              size={Math.max(1, width - 60)}
              direction={skipDirection}
            />
          </Animated.View>
        </View>

        <View style={styles.info}>
          <SongText style={styles.title} direction={skipDirection}>
            {track?.name ?? "Nothing playing"}
          </SongText>
          <SongText style={styles.artist} direction={skipDirection}>
            {track?.artist ??
              (view && !view.output ? "Choose an output below" : " ")}
          </SongText>
        </View>

        <View style={styles.progress}>
          <LiveProgress
            view={view}
            duration={duration}
            active={expanded}
            disabled={disabled}
            onSeek={(seconds) => send("seek", { positionSeconds: seconds })}
          />
        </View>

        <View style={styles.controls}>
          <Controls
            playing={playing}
            disabled={disabled}
            onPrevious={() => send("previous")}
            onToggle={toggle}
            onNext={() => send("next")}
          />
        </View>
      </View>
      <View style={[styles.footer, { bottom: insets.bottom + 8 }]}>
        <View style={styles.footerText}>
          <Touchable accessibilityRole="button" accessibilityLabel={`Change audio output, currently ${view?.output?.deviceName ?? "none selected"}`} scale={0.94} onPress={() => setOutputOpen(true)} style={styles.outputButton}>
            <Icon name="output" size={14} color={view?.output ? "white" : colors.muted} />
            <Text style={[styles.output, !view?.output && { color: colors.muted }]} numberOfLines={1}>{view?.output?.deviceName ?? "Choose an output"}</Text>
          </Touchable>
          {shownError && <Text accessibilityRole="alert" numberOfLines={2} style={styles.error}>{shownError}</Text>}
        </View>
        <Touchable accessibilityRole="button" accessibilityLabel="Open queue" scale={0.85} onPress={openQueue} style={styles.footerButton}><Icon name="queue" size={22} /></Touchable>
      </View>
      </Animated.View>
      </GestureDetector>
      {queueOpen && <QueueSheet view={view} onClose={closeQueue} />}
      {outputOpen && <OutputPicker view={view} onClose={closeOutput} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, overflow: "hidden", backgroundColor: colors.black },
  library: { flex: 1 },
  shade: { backgroundColor: colors.black },
  fullscreen: { backgroundColor: colors.black, overflow: "hidden", borderCurve: "continuous" },
  collapse: { position: "absolute", alignSelf: "center", height: 44, width: 72, alignItems: "center", justifyContent: "center", zIndex: 2 },
  grabHandle: { width: 36, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.4)" },
  footer: { position: "absolute", left: 20, right: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  footerText: { flex: 1, alignItems: "flex-start" },
  outputButton: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, maxWidth: "100%", paddingHorizontal: 12, borderRadius: 100, backgroundColor: "rgba(255, 255, 255, 0.08)" },
  footerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  output: { flexShrink: 1, color: "white", fontFamily: fonts.sans, fontSize: 12, fontWeight: "600" },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: 4, paddingHorizontal: 4 },
  mini: {
    position: "absolute",
    left: 8,
    right: 8,
    height: MINI_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 10,
    paddingRight: 4,
    borderRadius: 18,
    borderCurve: "continuous",
    overflow: "hidden",
    backgroundColor: colors.raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#262626",
  },
  miniTrack: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, height: MINI_HEIGHT },
  miniText: { flex: 1, gap: 3 },
  miniTitle: { color: "white", fontFamily: fonts.sans, fontSize: 14, fontWeight: "600" },
  miniArtist: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12 },
  miniButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  miniProgress: { position: "absolute", left: 16, right: 16, bottom: 0, height: 2, borderRadius: 1, overflow: "hidden", backgroundColor: "rgba(255, 255, 255, 0.1)" },
  miniFill: { height: 2, backgroundColor: "rgba(255, 255, 255, 0.8)", transformOrigin: "left" },
  content: { flex: 1, paddingHorizontal: 30 },
  coverSlot: { width: "100%", aspectRatio: 1 },
  cover: { flex: 1 },
  coverEmpty: {
    shadowColor: "white",
    shadowOpacity: 0.18,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 0 },
  },
  info: { marginTop: 40 },
  title: {
    color: "white",
    fontFamily: fonts.sans,
    fontSize: 19,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  artist: { color: "rgba(255, 255, 255, 0.75)", fontFamily: fonts.sans, fontSize: 16, marginTop: 6 },
  progress: { marginTop: 28 },
  controls: { flex: 1, justifyContent: "center", paddingBottom: "30%" },
});
