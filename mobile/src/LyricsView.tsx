import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactElement } from "react";
import { AccessibilityInfo, ActivityIndicator, AppState, StyleSheet, Text, View, useWindowDimensions, type TextStyle, type ViewProps } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { Easing, useAnimatedReaction, useAnimatedStyle, useFrameCallback, useSharedValue, withTiming, type FrameInfo, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { needsLyricsRetry, type TrackLyrics } from "../../desktop/src/utils/lyricsWire";
import { lyricActive } from "../../desktop/src/utils/lyricsTiming";
import { sessionViewAge, type SessionView, type Track } from "./client";
import { refreshLyricPlayback } from "./lyricsPlayback";
import { focusBlock, lyricBlocks, lyricSeekSeconds, lyricWordRuns, type LyricBlock, type LyricRow } from "./lyricsModel";
import { useLyrics } from "./useLyrics";
import { lyricPositionMs, nudgeLyricSync } from "./lyricSync";
import { useLyricSync } from "./useLyricSync";
import { LyricSyncControls } from "./LyricSyncControls";
import { advanceNativeDot, advanceNativeLetter, lyricClockStep, lyricFontSize, nativeDot, nativeLetter, shouldAdvanceLyricRow, type LyricScrollMotion, type NativeLetter } from "./lyricsAnimation";
import { LyricCell, LyricList, LyricMeasurements, useLyricScroll } from "./useLyricScroll";
import { Icon } from "./Icons";
import { Touchable } from "./Touchable";
import { colors, fonts } from "./theme";

// MaskedView 0.3.2's constructor intersection loses component props with TypeScript 6.
const FadeMask = MaskedView as unknown as ComponentType<ViewProps & { maskElement: ReactElement }>;
const sources = { amll: "AMLL TTML DB", "lrc.red": "lrc.red", lrclib: "LRCLIB" };
// CSS `ease`, matching the desktop line and group fades.
const lyricEase = Easing.bezier(0.25, 0.1, 0.25, 1);

function useLyricClock(view: SessionView | null, duration: number, offset: number, active: boolean) {
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [reduced, setReduced] = useState(false);
  const [initial] = useState(() => ({ time: lyricPositionMs(view, sessionViewAge(), duration, offset), wall: Date.now(), end: (duration || 86_400) * 1000 + offset, playing: !!view?.playing && !view.buffering }));
  const time = useSharedValue(initial.time);
  const sample = useSharedValue(initial);
  const initialized = useSharedValue(false);
  const activation = useRef({ shown: false, offset });
  const resyncAbort = useRef<AbortController | null>(null);
  const held = useRef<{ seconds: number; at: number; revision: number } | null>(null);
  const trackId = view?.queue.current?.globalTrackId;
  const [previewRevision, setPreviewRevision] = useState(0);
  const position = useCallback(() => {
    const candidate = held.current;
    const pending = candidate && candidate.revision === view?.revision && Date.now() - candidate.at < 5000 ? candidate : null;
    return lyricPositionMs(pending && view ? { ...view, positionSeconds: pending.seconds } : view,
      pending ? (Date.now() - pending.at) / 1000 : sessionViewAge(), duration, offset);
  }, [view, duration, offset]);
  useEffect(() => {
    let disposed = false;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (!disposed) setReduced(value); });
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    const state = AppState.addEventListener("change", state => setForeground(state === "active"));
    return () => { disposed = true; motion.remove(); state.remove(); };
  }, []);
  useEffect(() => {
    const report = { time: position(), wall: Date.now(), end: (duration || 86_400) * 1000 + offset, playing: !!view?.playing && !view.buffering };
    sample.set(report);
    const shown = active && foreground;
    if (shown && (!activation.current.shown || activation.current.offset !== offset)) {
      time.set(report.time);
      initialized.set(false);
    }
    activation.current = { shown, offset };
  }, [view, duration, offset, position, sample, time, initialized, previewRevision, active, foreground]);
  useEffect(() => {
    if (!active || !foreground) return;
    const abort = new AbortController();
    void refreshLyricPlayback(abort.signal).catch(() => {});
    return () => abort.abort();
  }, [active, foreground]);
  useEffect(() => () => resyncAbort.current?.abort(), []);
  const clock = useFrameCallback(useCallback((info: FrameInfo) => {
    "worklet";
    const report = sample.get();
    const sampled = Math.min(report.end, report.time + (report.playing ? Date.now() - report.wall : 0));
    time.set(Math.min(report.end, lyricClockStep(initialized.get() ? time.get() : NaN, sampled, (info.timeSincePreviousFrame ?? 0) / 1000, report.playing)));
    initialized.set(true);
  }, [sample, time, initialized]), false);
  useEffect(() => { clock.setActive(active && foreground); return () => clock.setActive(false); }, [clock, active, foreground]);
  const preview = useCallback((seconds: number) => {
    held.current = { seconds, at: Date.now(), revision: view?.revision ?? 0 };
    const at = position();
    time.set(at);
    setPreviewRevision(value => value + 1);
  }, [position, time, view?.revision]);
  const resync = useCallback(async () => {
    resyncAbort.current?.abort();
    const abort = new AbortController();
    resyncAbort.current = abort;
    const playback = await refreshLyricPlayback(abort.signal, true);
    if (!playback) return;
    const fresh = playback.view;
    if (fresh?.queue.current?.globalTrackId !== trackId) return;
    held.current = null;
    const report = { time: lyricPositionMs(fresh, playback.ageSeconds, duration, offset), wall: Date.now(), end: (duration || 86_400) * 1000 + offset, playing: !!fresh?.playing && !fresh.buffering };
    sample.set(report);
    time.set(report.time);
    initialized.set(false);
  }, [trackId, duration, offset, sample, time, initialized]);
  return { time, reduced, running: active && foreground, preview, resync };
}

const LetterGlow = memo(function LetterGlow({ text, index, letters, font, animate }: { text: string; index: number; letters: SharedValue<NativeLetter[]>; font: TextStyle; animate: boolean }) {
  const glow = useAnimatedStyle(() => ({ opacity: animate ? (letters.get()[index]?.glow.value ?? 0) * 0.5 : 0 }));
  return <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, glow]}><Text accessible={false} maxFontSizeMultiplier={1.4} style={[font, styles.letter, { textShadowColor: "white", textShadowRadius: Number(font.fontSize) * 0.18, textShadowOffset: { width: 0, height: 0 } }]}>{text}</Text></Animated.View>;
});

const Letter = memo(function Letter({ text, index, letters, font, emphasis, animate, past }: { text: string; index: number; letters: SharedValue<NativeLetter[]>; font: TextStyle; emphasis: boolean; animate: boolean; past: boolean }) {
  const size = Number(font.fontSize);
  const style = useAnimatedStyle(() => {
    const pose = letters.get()[index];
    return {
      opacity: 0.45 + 0.55 * (animate && pose ? pose.head : past ? 1 : 0),
      transform: [{ translateY: animate && pose ? -pose.lift.value * size : 0 }, { scale: animate && pose ? pose.scale.value : 1 }],
    };
  });
  // Animate compositor layers, leaving font shaping and text-shadow properties static.
  return <Animated.View accessible={false} style={[styles.glyph, style]}>
    <Text accessible={false} maxFontSizeMultiplier={1.4} style={[font, styles.letter]}>{text}</Text>
    {emphasis && <LetterGlow {...{ text, index, letters, font, animate }} />}
  </Animated.View>;
});

const Row = memo(function Row({ row, time, fontSize, animate, past, plain, reduced, offset, disabled, onSeek }: {
  row: LyricRow; time: SharedValue<number>; fontSize: number; animate: boolean; past: boolean; plain: boolean; reduced: boolean; offset: number; disabled: boolean; onSeek: (seconds: number) => void;
}) {
  const letters = useSharedValue(row.words.flatMap(word => word.letters.map(letter => nativeLetter(letter.motion))));
  const runs = useMemo(() => lyricWordRuns(row.words), [row.words]);
  const last = useSharedValue({ time: NaN, moving: true });
  // A provider retry may replace text/timings under the same row ID. Reset its physics when content changes.
  useEffect(() => {
    letters.set(row.words.flatMap(word => word.letters.map(letter => nativeLetter(letter.motion))));
    last.set({ time: NaN, moving: true });
  }, [row.words, reduced, letters, last]);
  const timing = useMemo(() => ({ startMs: row.line.startMs, endMs: row.line.endMs }), [row.line]);
  const frame = useFrameCallback(useCallback((info: FrameInfo) => {
    "worklet";
    const at = time.get();
    const previous = last.get();
    const seconds = Math.min(0.05, (info.timeSincePreviousFrame ?? 16.67) / 1000);
    const active = lyricActive(timing, at);
    const { snap, advance } = shouldAdvanceLyricRow(previous, at, active, seconds);
    if (!advance) { last.set({ time: at, moving: false }); return; }
    let moving = false;
    letters.modify(values => {
      for (const letter of values) moving = advanceNativeLetter(letter, at, active, seconds, snap, reduced) || moving;
      return values;
    });
    last.set({ time: at, moving });
  }, [time, last, timing, letters, reduced]), false);
  useEffect(() => { frame.setActive(animate && !plain && row.words.length > 0); return () => frame.setActive(false); }, [frame, animate, plain, row.words.length]);
  const font = useMemo<TextStyle>(() => ({
    fontFamily: fonts.sans, fontSize: row.kind === "background" ? fontSize * 0.72 : row.kind === "romanization" ? 16 : fontSize,
    fontWeight: row.kind === "lead" ? 600 : row.kind === "background" ? 500 : 400,
    fontVariationSettings: { wght: row.kind === "lead" ? 650 : row.kind === "background" ? 500 : 400 },
    fontStyle: row.kind === "romanization" ? "italic" : "normal",
    lineHeight: row.kind === "romanization" ? 24 : Math.round((row.kind === "background" ? fontSize * 0.72 : fontSize) * 1.27),
    letterSpacing: row.kind === "romanization" ? 0 : -fontSize * (row.kind === "background" ? 0.02 : 0.035),
    includeFontPadding: false,
    textAlign: row.alternate ? "right" : "left",
    color: plain ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.72)",
  }), [fontSize, row.kind, row.alternate, plain]);
  let letterIndex = 0;
  const intensity = useSharedValue(plain ? 0.92 : 0.72);
  useAnimatedReaction(() => plain ? 0.92 : lyricActive(timing, time.get()) ? 1 : 0.72, (next, previous) => {
    if (next !== previous) intensity.set(withTiming(next, { duration: reduced ? 150 : 400, easing: lyricEase }));
  });
  const colorStyle = useAnimatedStyle(() => ({ opacity: intensity.get() }));
  const content = <>
    {!!row.singer && <Text style={styles.singer}>{row.singer}</Text>}
    {row.words.length && !plain ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.words, row.alternate && styles.alternate]}>
      {runs.map((word, index) => word.break ? <View key={index} style={styles.lineBreak} />
        : <View key={index} style={styles.word}>{word.letters.map((letter, index) => <Letter key={index} text={letter.text} index={letterIndex++} letters={letters} font={font} animate={animate} past={past} emphasis={letter.motion.emphasis && !reduced} />)}{!!word.trailing && <Text accessible={false} maxFontSizeMultiplier={1.4} style={font}>{word.trailing}</Text>}</View>)}
    </View> : <Animated.View style={colorStyle}><Text accessible={false} maxFontSizeMultiplier={1.4} style={[font, styles.letter]}>{row.line.text || "\u00a0"}</Text></Animated.View>}
  </>;
  const style = row.kind === "lead" ? undefined : { marginTop: row.kind === "background" ? 10 : 9 };
  const seekable = !disabled && !plain && row.kind !== "romanization" && row.line.startMs !== null;
  return seekable
    ? <Touchable accessibilityRole="button" accessibilityLabel={row.line.text} accessibilityHint="Play from this lyric" scale={0.985} onPress={() => onSeek(lyricSeekSeconds(row.line.startMs!, offset))} style={style}>{content}</Touchable>
    : <View accessible accessibilityRole="text" accessibilityLabel={row.line.text} style={style}>{content}</View>;
});

function PauseDot({ index, block, time, reduced, running }: { index: number; block: Extract<LyricBlock, { kind: "pause" }>; time: SharedValue<number>; reduced: boolean; running: boolean }) {
  const dot = useSharedValue(nativeDot());
  const { startMs, endMs } = block;
  const frame = useFrameCallback(useCallback((info: FrameInfo) => {
    "worklet";
    dot.modify(state => { advanceNativeDot(state, index, time.get(), startMs, endMs, Math.min(0.05, (info.timeSincePreviousFrame ?? 16.67) / 1000), reduced); return state; });
  }, [dot, index, time, startMs, endMs, reduced]), false);
  useEffect(() => { frame.setActive(running); return () => frame.setActive(false); }, [frame, running]);
  const style = useAnimatedStyle(() => ({ opacity: dot.get().opacity, transform: [{ translateX: dot.get().x }, { translateY: dot.get().y }, { scale: dot.get().scale }] }));
  return <Animated.View style={[styles.dot, style]} />;
}

function useRippleStyle(index: number, motion: SharedValue<LyricScrollMotion>, followingUI: SharedValue<boolean>, reduced: boolean) {
  return useAnimatedStyle(() => {
    const state = motion.get();
    const ripple = state.ripples[index];
    return { transform: [{ translateY: !followingUI.get() || reduced || !ripple || ripple.epoch < 0 ? 0 : state.offset - ripple.value }] };
  });
}

function Credits({ lyrics, plain, motion, followingUI, reduced, index }: { lyrics: TrackLyrics; plain: boolean; motion: SharedValue<LyricScrollMotion>; followingUI: SharedValue<boolean>; reduced: boolean; index: number }) {
  const style = useRippleStyle(index, motion, followingUI, reduced);
  return <Animated.View style={[styles.credits, style]}><Text style={styles.credit}>{plain ? "Lyrics" : lyrics.hasWordSync ? "Word-synced lyrics" : "Line-synced lyrics"}</Text>{lyrics.source && <Text style={styles.source}>Lyrics from {sources[lyrics.source]}</Text>}</Animated.View>;
}

const Group = memo(function Group({ block, index, focus, following, time, fontSize, plain, reduced, running, offset, disabled, onSeek, scrollMotion, followingUI }: {
  block: LyricBlock; index: number; focus: number; following: boolean; time: SharedValue<number>; fontSize: number; plain: boolean; reduced: boolean; running: boolean; offset: number; disabled: boolean; onSeek: (seconds: number) => void;
  scrollMotion: SharedValue<LyricScrollMotion>; followingUI: SharedValue<boolean>;
}) {
  const distance = Math.abs(index - focus);
  const fade = useSharedValue(0.38);
  const rippleStyle = useRippleStyle(index, scrollMotion, followingUI, reduced);
  useAnimatedReaction(() => {
    const active = block.kind === "lines" && block.rows.some(row => lyricActive(row.line, time.get()));
    return plain ? 1 : !following ? 0.75 : active || index === focus ? 1 : index < focus ? 0.28 : Math.max(0.24, 0.72 - distance * 0.13);
  }, (target, previous) => {
    if (target !== previous) fade.set(withTiming(target, { duration: reduced ? 150 : 500, easing: lyricEase }));
  });
  const style = useAnimatedStyle(() => ({ opacity: fade.get() }));
  if (block.kind === "pause") return <Animated.View accessible={index === focus} accessibilityLabel="Instrumental break" style={[{ height: index === focus ? 56 : 0, overflow: "hidden" }, style, rippleStyle]}><View style={styles.dots}>{[0, 1, 2].map(dotIndex => <PauseDot key={dotIndex} index={dotIndex} {...{ block, time, reduced }} running={running && index === focus} />)}</View></Animated.View>;
  return <Animated.View style={[styles.group, style, rippleStyle]}>{block.rows.map(row => <Row key={row.id} {...{ row, time, fontSize, plain, reduced, offset, disabled, onSeek }} animate={running && distance <= 2} past={index < focus} />)}</Animated.View>;
});

function LyricLines({ lyrics, view, duration, active, height, disabled, onSeek, retry, sync }: { lyrics: TrackLyrics; view: SessionView | null; duration: number; active: boolean; height: number; disabled: boolean; onSeek: (seconds: number) => void; retry: () => void; sync: ReturnType<typeof useLyricSync> }) {
  const { width } = useWindowDimensions();
  const fontSize = lyricFontSize(width);
  const { time, reduced, running, preview, resync } = useLyricClock(view, duration, lyrics.offsetMs, active);
  const blocks = useMemo(() => lyricBlocks(lyrics), [lyrics]);
  const plain = lyrics.sync === "none" || sync.value.unsynced;
  const [focus, setFocus] = useState(() => plain ? -1 : focusBlock(lyrics, blocks, lyricPositionMs(view, sessionViewAge(), duration, lyrics.offsetMs)));
  // Only line changes cross to React; the display-rate clock and letter physics stay on the UI thread.
  useAnimatedReaction(() => plain ? -1 : focusBlock(lyrics, blocks, time.get()), (next, previous) => {
    if (next !== previous) scheduleOnRN(setFocus, next);
  });
  const [following, setFollowing] = useState(true);
  const { list: listRef, motion: scrollMotion, followingUI, record, contentSize, failed, realign } = useLyricScroll({ blocks, focus, height, fontSize, running, following, reduced, plain });
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seek = useRef(onSeek);
  useEffect(() => { seek.current = onSeek; }, [onSeek]);
  const stopTimer = useCallback(() => { if (resumeTimer.current) clearTimeout(resumeTimer.current); resumeTimer.current = null; }, []);
  useEffect(() => () => stopTimer(), [stopTimer]);
  useEffect(() => { if (!running) stopTimer(); }, [running, stopTimer]);
  const resume = useCallback(() => { stopTimer(); setFollowing(true); realign(); }, [stopTimer, realign]);
  const syncPlayback = useCallback(async () => { resume(); try { await resync(); } finally { resume(); } }, [resync, resume]);
  const armResume = useCallback(() => { stopTimer(); if (!plain && running) resumeTimer.current = setTimeout(() => setFollowing(true), 5000); }, [plain, running, stopTimer]);
  const lineSeek = useCallback((seconds: number) => { stopTimer(); preview(seconds); setFollowing(true); seek.current(seconds); }, [preview, stopTimer]);
  const renderItem = useCallback(({ item, index }: { item: LyricBlock; index: number }) => <Group block={item} {...{ index, focus, following, time, fontSize, plain, reduced, running, disabled, scrollMotion, followingUI }} offset={lyrics.offsetMs} onSeek={lineSeek} />, [focus, following, time, fontSize, plain, reduced, running, disabled, lyrics.offsetMs, lineSeek, scrollMotion, followingUI]);
  const contentStyle = useMemo(() => ({ paddingHorizontal: 26, paddingTop: plain ? 24 : height * 0.43, paddingBottom: plain ? 90 : height * 0.57 }), [plain, height]);
  return <View style={styles.fill}>
    <FadeMask style={styles.fill} maskElement={<LinearGradient colors={["transparent", "black", "black", "transparent"]} locations={[0, 0.14, 0.82, 1]} style={StyleSheet.absoluteFill} />}>
      <LyricMeasurements record={record}><LyricList ref={listRef} data={blocks} keyExtractor={block => block.id} renderItem={renderItem} CellRendererComponent={LyricCell} style={styles.fill} contentContainerStyle={contentStyle} showsVerticalScrollIndicator={false} initialNumToRender={6} maxToRenderPerBatch={5} windowSize={5} removeClippedSubviews={false} scrollEventThrottle={16} onContentSizeChange={contentSize}
        onScrollBeginDrag={() => { if (!plain) setFollowing(false); stopTimer(); }} onScrollEndDrag={armResume} onMomentumScrollBegin={stopTimer} onMomentumScrollEnd={armResume}
        onScrollToIndexFailed={failed}
        ListHeaderComponent={plain ? <View style={styles.plainNote}><Text style={styles.credit}>Lyrics aren’t time-synced.</Text>{needsLyricsRetry(lyrics) && <Touchable onPress={retry} scale={0.97}><Text style={styles.retryText}>Check for synced lyrics</Text></Touchable>}</View> : undefined}
        ListFooterComponent={<Credits {...{ lyrics, plain, followingUI, reduced }} motion={scrollMotion} index={blocks.length - 1} />}
      /></LyricMeasurements>
    </FadeMask>
    {lyrics.sync !== "none" && <LyricSyncControls value={sync.value} loaded={sync.loaded} error={sync.error} {...{ following, plain, height }} onResume={resume} onResync={syncPlayback} onNudge={delta => { sync.update(value => nudgeLyricSync(value, delta)); resume(); }} onReset={() => { sync.update(value => ({ ...value, correctionMs: 0 })); resume(); }} onToggle={() => { sync.update(value => ({ ...value, unsynced: !value.unsynced })); resume(); }} />}
  </View>;
}

export function LyricsView({ track, view, active, height, disabled, onSeek }: { track: Track | null; view: SessionView | null; active: boolean; height: number; disabled: boolean; onSeek: (seconds: number) => void }) {
  const result = useLyrics(track, active);
  const sync = useLyricSync(track?.globalId ?? "");
  const lyrics = useMemo(() => result.lyrics && sync.value.correctionMs ? { ...result.lyrics, offsetMs: result.lyrics.offsetMs + sync.value.correctionMs } : result.lyrics, [result.lyrics, sync.value.correctionMs]);
  if (lyrics?.status === "lyrics" && lyrics.lines.length) return <LyricLines key={result.key} lyrics={lyrics} view={view} duration={view?.duration || track?.durationSeconds || 0} {...{ active, height, disabled, onSeek, sync }} retry={result.retry} />;
  if (!active && !result.lyrics && !result.error) return null;
  const instrumental = result.lyrics?.status === "instrumental";
  return <View style={styles.message}>
    {result.loading ? <ActivityIndicator color="white" accessibilityLabel="Finding lyrics" /> : <Icon name="lyrics" size={30} color={colors.secondary} />}
    <Text style={styles.messageTitle}>{!track ? "Choose a song" : result.loading ? "Finding lyrics…" : instrumental ? "Instrumental" : result.error ? "Lyrics couldn’t load" : "No lyrics for this song yet"}</Text>
    <Text style={styles.messageDetail}>{instrumental ? "No vocals in this track." : result.error || (!track ? "Your lyrics will appear here." : " ")}</Text>
    {!!track && !result.loading && !instrumental && <Touchable accessibilityRole="button" accessibilityLabel="Retry lyrics" onPress={result.retry} scale={0.96} style={styles.retry}><Text style={styles.retryText}>Try again</Text></Touchable>}
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  group: { marginBottom: 32 },
  glyph: { transformOrigin: "50% 80%" },
  letter: { color: "white" },
  words: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline" },
  alternate: { justifyContent: "flex-end" },
  word: { flexDirection: "row", flexWrap: "wrap", maxWidth: "100%" },
  lineBreak: { width: "100%", height: 0 },
  singer: { color: "rgba(255,255,255,0.6)", fontFamily: fonts.sans, fontSize: 11, lineHeight: 16.5, marginTop: 10, marginBottom: 5 },
  dots: { flexDirection: "row", alignItems: "center", gap: 11, height: 26, paddingHorizontal: 2 },
  dot: { width: 11, height: 11, borderRadius: 6, backgroundColor: "white" },
  credits: { marginTop: 30, gap: 4 },
  credit: { color: "rgba(255,255,255,0.6)", fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  source: { color: "rgba(255,255,255,0.4)", fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  plainNote: { gap: 12, marginBottom: 26 },
  resume: { position: "absolute", bottom: 8, alignSelf: "center", minHeight: 42, paddingHorizontal: 17, borderRadius: 100, borderWidth: StyleSheet.hairlineWidth, borderColor: "#454545", backgroundColor: "rgba(22,22,22,0.94)", flexDirection: "row", alignItems: "center", gap: 8 },
  resumeText: { color: "white", fontFamily: fonts.sans, fontSize: 13, fontWeight: "500" },
  message: { flex: 1, alignItems: "flex-start", justifyContent: "center", paddingHorizontal: 30, gap: 18 },
  messageTitle: { color: "rgba(255,255,255,0.85)", fontFamily: fonts.sans, fontWeight: "600", fontSize: 28, lineHeight: 35.5, letterSpacing: -0.98 },
  messageDetail: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 21 },
  retry: { minHeight: 42, borderRadius: 100, paddingHorizontal: 20, justifyContent: "center", backgroundColor: "rgba(255,255,255,0.12)" },
  retryText: { color: "white", fontFamily: fonts.sans, fontSize: 13, fontWeight: "500" },
});
