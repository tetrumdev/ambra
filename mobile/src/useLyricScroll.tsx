import { createContext, memo, useCallback, useContext, useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { FlatList, View, type FlatListProps } from "react-native";
import Animated, { scrollTo, useAnimatedRef, useFrameCallback, useScrollOffset, useSharedValue, type FrameInfo } from "react-native-reanimated";
import { advanceLyricScrollMotion, lyricRipple, lyricScrollSettled, lyricScrollTarget, type LyricScrollGoal, type LyricScrollMotion } from "./lyricsAnimation";
import type { LyricBlock } from "./lyricsModel";

// Use RN's cell renderer API so measured content coordinates include wrapping and singer labels.
export const LyricList = Animated.createAnimatedComponent(FlatList<LyricBlock>);
const CellLayout = createContext<(index: number, top: number | null, height: number) => void>(() => {});
type CellProps = ComponentProps<NonNullable<FlatListProps<LyricBlock>["CellRendererComponent"]>>;
export const LyricCell = memo(function LyricCell({ index, children, onLayout, onFocusCapture, style }: CellProps) {
  const record = useContext(CellLayout);
  useEffect(() => () => record(index, null, 0), [index, record]);
  return <View style={style} onFocusCapture={onFocusCapture} onLayout={event => {
    onLayout?.(event);
    const { y, height } = event.nativeEvent.layout;
    record(index, y, height);
  }}>{children}</View>;
});
export function LyricMeasurements({ record, children }: { record: (index: number, top: number | null, height: number) => void; children: ReactNode }) {
  return <CellLayout.Provider value={record}>{children}</CellLayout.Provider>;
}

export function useLyricScroll({ blocks, focus, height, fontSize, running, following, reduced, plain }: {
  blocks: LyricBlock[]; focus: number; height: number; fontSize: number; running: boolean; following: boolean; reduced: boolean; plain: boolean;
}) {
  const list = useAnimatedRef<FlatList<LyricBlock>>();
  const nativeOffset = useScrollOffset(list);
  const goal = useSharedValue<LyricScrollGoal>({ offset: 0, focus: -1, origin: -1, epoch: 0, snap: true });
  const motion = useSharedValue<LyricScrollMotion>({ offset: 0, ripples: blocks.map(lyricRipple) });
  const appliedEpoch = useSharedValue(-1);
  const followingUI = useSharedValue(following && !plain);
  const measure = useRef(new Map<number, { top: number; height: number }>());
  const content = useRef(0);
  const target = useRef({ index: -1, attempts: 0, epoch: 0, previousFocus: -1, previousOffset: 0, force: true });
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ focus, height, fontSize, running, following, reduced, plain, blocks });
  useEffect(() => { latest.current = { focus, height, fontSize, running, following, reduced, plain, blocks }; });
  useEffect(() => { followingUI.set(following && !plain); }, [following, plain, followingUI]);
  const frame = useFrameCallback(useCallback((info: FrameInfo) => {
    "worklet";
    const next = goal.get();
    if (next.focus < 0) return;
    const following = followingUI.get();
    if (following && appliedEpoch.get() === next.epoch && lyricScrollSettled(motion.get(), next)) return;
    if (!following && appliedEpoch.get() === -1 && motion.get().offset === nativeOffset.get()) return;
    // Desktop jumps the real scroll once and hides it with each line's transform.
    // Advance every line in the same UI frame, without waiting for scroll events.
    motion.modify(state => {
      advanceLyricScrollMotion(state, next, info.timestamp, Math.min(0.1, (info.timeSincePreviousFrame ?? 16.67) / 1000), nativeOffset.get(), following, reduced);
      return state;
    });
    if (!following) { appliedEpoch.set(-1); return; }
    if (appliedEpoch.get() !== next.epoch) {
      scrollTo(list, 0, motion.get().offset, false);
      appliedEpoch.set(next.epoch);
    }
  }, [goal, nativeOffset, followingUI, motion, appliedEpoch, reduced, list]), false);
  useEffect(() => { frame.setActive(running && !plain); return () => frame.setActive(false); }, [frame, running, plain]);

  const align = useCallback(() => {
    const state = latest.current;
    if (!state.running || state.plain || !state.following || state.focus < 0) return;
    const cell = measure.current.get(state.focus);
    if (!cell) {
      if (target.current.index !== state.focus) {
        target.current.attempts = 0;
        if (retry.current) clearTimeout(retry.current);
        retry.current = null;
      }
      target.current.index = state.focus;
      if (retry.current || target.current.attempts >= 40) return;
      // Let FlatList render the distant row before the ripple controller claims the scroll offset.
      goal.set({ offset: 0, focus: -1, origin: -1, epoch: -1, snap: true });
      list.current?.scrollToIndex({ index: state.focus, animated: false, viewPosition: 0.43 });
      return;
    }
    if (retry.current) clearTimeout(retry.current);
    retry.current = null;
    const block = state.blocks[state.focus];
    const anchor = block.kind === "pause" ? 12 : state.fontSize * 1.27 / 2 + (block.rows[0]?.singer ? 31 : 0);
    const next = lyricScrollTarget(cell.top, anchor, state.height, content.current);
    const last = target.current;
    if (!last.force && next === last.previousOffset && state.focus === last.previousFocus && last.epoch > 0) return;
    const direction = Math.sign(next - last.previousOffset);
    const origin = last.previousFocus < 0 ? state.focus : direction >= 0 ? Math.min(last.previousFocus, state.focus) : Math.max(last.previousFocus, state.focus);
    goal.set({ offset: next, focus: state.focus, origin, epoch: ++last.epoch, snap: last.force || last.epoch === 1 || state.reduced });
    last.force = false;
    last.previousFocus = state.focus;
    last.previousOffset = next;
    last.index = state.focus;
    last.attempts = 0;
  }, [goal, list]);
  const record = useCallback((index: number, top: number | null, height: number) => {
    if (top === null) { measure.current.delete(index); return; }
    measure.current.set(index, { top, height });
    align();
  }, [align]);
  const contentSize = useCallback((_width: number, height: number) => { content.current = height; align(); }, [align]);
  useEffect(() => {
    if (running) target.current.force = true;
  }, [running]);
  useEffect(() => {
    const paint = requestAnimationFrame(align);
    return () => cancelAnimationFrame(paint);
  }, [focus, height, fontSize, running, following, reduced, align]);
  useEffect(() => { if (!following) { target.current.previousFocus = -1; target.current.force = true; } }, [following]);
  useEffect(() => () => { if (retry.current) clearTimeout(retry.current); }, []);
  const failed = useCallback((info: { index: number; averageItemLength: number }) => {
    if (!latest.current.running || !latest.current.following || target.current.index !== info.index || target.current.attempts++ >= 40) return;
    list.current?.scrollToOffset({ offset: Math.max(0, info.averageItemLength * info.index - latest.current.height * 0.43), animated: false });
    if (retry.current) clearTimeout(retry.current);
    retry.current = setTimeout(() => { retry.current = null; align(); }, 120);
  }, [list, align]);
  const realign = useCallback(() => {
    target.current.force = true;
    target.current.attempts = 0;
    target.current.previousFocus = -1;
    if (retry.current) clearTimeout(retry.current);
    retry.current = null;
    requestAnimationFrame(align);
  }, [align]);
  return { list, motion, followingUI, record, contentSize, failed, realign };
}
