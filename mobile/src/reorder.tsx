import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from "react";
import { StyleSheet, View, type FlatList, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { haptic, radius } from "./theme";
import { HOLD_MS, type Frame } from "./Touchable";
import { closeMenu } from "./shell/ContextMenu";
import { ROW_HEIGHT } from "./TrackRow";

/** Rows are this tall (TrackRow), so a finger's position names the row under it. */
export { ROW_HEIGHT };
/** How close to an edge the finger has to be before the list scrolls by itself. */
const EDGE = 72;
const SCROLL_STEP = 14;
/** A hold that moves less than this is a plain hold: it opens the menu instead. */
const STILL = 8;

type Controller = {
  /** `continued`: the row is already lifted (under its menu), so it doesn't lift again. */
  begin(index: number, absoluteY: number, rowTop: number, continued?: boolean): void;
  move(absoluteY: number): void;
  end(moved: boolean): void;
  cancel(): void;
};

export type Reorder = {
  /** Which row is lifted, or null. */
  dragging: number | null;
  controller: RefObject<Controller>;
  from: SharedValue<number>;
  to: SharedValue<number>;
  /** Props for the FlatList whose rows move. */
  listProps: {
    onScroll(event: NativeSyntheticEvent<NativeScrollEvent>): void;
    scrollEventThrottle: number;
    scrollEnabled: boolean;
  };
  /** For the View that holds the list, so the lifted row can float over it. */
  containerProps: { ref: RefObject<ComponentRef<typeof View> | null>; onLayout(event: LayoutChangeEvent): void; collapsable: false };
  /** Where the rows start in the list's content (after its header). */
  onRowsLayout(top: number): void;
  overlay: ReactNode;
};

/**
 * Hold a song, then drag it: like rearranging an iPhone home screen, the row lifts after the
 * hold, the others slide out of its way, and the list scrolls when it nears an edge. A hold
 * let go without moving opens the song's menu, as before.
 */
export function useReorder({ list, count, onMove, renderLifted }: {
  list: RefObject<FlatList<never> | FlatList<unknown> | null>;
  count: number;
  onMove(from: number, to: number): void;
  renderLifted(index: number): ReactNode;
}): Reorder {
  const from = useSharedValue(-1);
  const to = useSharedValue(-1);
  const liftedY = useSharedValue(0);
  const lift = useSharedValue(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const container = useRef<ComponentRef<typeof View> | null>(null);
  const frame = useRef({ top: 0, height: 0 });
  const scroll = useRef(0);
  const rowsTop = useRef(0);
  const touch = useRef({ grab: 0, y: 0, index: -1 });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const latest = useRef({ count, onMove });
  useEffect(() => { latest.current = { count, onMove }; });

  const target = useCallback((absoluteY: number) => {
    const inContent = absoluteY - frame.current.top + scroll.current - rowsTop.current;
    return Math.max(0, Math.min(latest.current.count - 1, Math.floor(inContent / ROW_HEIGHT)));
  }, []);
  const place = useCallback(() => {
    liftedY.set(touch.current.y - frame.current.top - touch.current.grab);
    const next = target(touch.current.y);
    if (next !== to.get()) { to.set(next); haptic.tick(); }
  }, [liftedY, target, to]);
  const stopScrolling = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);
  const finish = useCallback(() => {
    stopScrolling();
    lift.set(withTiming(0, { duration: 140 }));
    from.set(-1);
    to.set(-1);
    touch.current.index = -1;
    setDragging(null);
  }, [from, lift, stopScrolling, to]);

  const controller = useRef<Controller>({
    begin: () => {},
    move: () => {},
    end: () => {},
    cancel: () => {},
  });
  useLayoutEffect(() => {
    controller.current = {
      begin(index, absoluteY, rowTop, continued = false) {
        container.current?.measureInWindow((_, top, __, height) => { frame.current = { top, height }; });
        touch.current = { grab: Math.max(0, Math.min(ROW_HEIGHT, rowTop)), y: absoluteY, index };
        from.set(index);
        to.set(index);
        liftedY.set(absoluteY - frame.current.top - touch.current.grab);
        lift.set(continued ? 1 : withTiming(1, { duration: 160 }));
        setDragging(index);
        if (continued) haptic.tick(); else haptic.hold();
        // Near an edge the list scrolls under the finger, and the row under it follows.
        stopScrolling();
        timer.current = setInterval(() => {
          const y = touch.current.y - frame.current.top;
          const speed = y < EDGE ? -SCROLL_STEP * (1 - y / EDGE) : y > frame.current.height - EDGE ? SCROLL_STEP * (1 - (frame.current.height - y) / EDGE) : 0;
          if (!speed) return;
          const offset = Math.max(0, scroll.current + speed);
          if (offset === scroll.current) return;
          scroll.current = offset;
          list.current?.scrollToOffset({ offset, animated: false });
          place();
        }, 16);
      },
      move(absoluteY) {
        if (touch.current.index < 0) return;
        touch.current.y = absoluteY;
        place();
      },
      end(moved) {
        const start = from.get();
        const end = to.get();
        finish();
        if (moved && start >= 0 && end >= 0 && start !== end) {
          haptic.success();
          latest.current.onMove(start, end);
        }
      },
      cancel: finish,
    };
  });
  useEffect(() => stopScrolling, [stopScrolling]);

  const liftedStyle = useAnimatedStyle(() => ({
    top: liftedY.get(),
    opacity: lift.get(),
    transform: [{ scale: 1 + 0.03 * lift.get() }],
    shadowOpacity: 0.5 * lift.get(),
  }));
  const listProps = useMemo(() => ({
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => { scroll.current = event.nativeEvent.contentOffset.y; },
    scrollEventThrottle: 16,
    scrollEnabled: dragging === null,
  }), [dragging]);
  return {
    dragging,
    controller,
    from,
    to,
    listProps,
    containerProps: {
      ref: container,
      onLayout: () => container.current?.measureInWindow((_, top, __, height) => { frame.current = { top, height }; }),
      collapsable: false,
    },
    onRowsLayout: top => { rowsTop.current = top; },
    overlay: dragging !== null ? <Animated.View pointerEvents="none" style={[styles.lifted, liftedStyle]}>{renderLifted(dragging)}</Animated.View> : null,
  };
}

/**
 * A row you hold: it lifts and its menu opens beside it (`onHold`, with where the row is).
 * Letting go keeps the menu. In a list that can be reordered, moving the finger instead closes
 * the menu and carries the row: the others slide out of its way.
 */
export function ReorderRow({ index, reorder, enabled = true, onHold, children }: {
  index: number;
  /** Leave out for lists whose order can't change. */
  reorder?: Reorder;
  enabled?: boolean;
  onHold?: (index: number, frame: Frame) => void;
  children: ReactNode;
}) {
  const unused = useSharedValue(-1);
  const from = reorder?.from ?? unused;
  const to = reorder?.to ?? unused;
  const size = useRef({ width: 0, height: ROW_HEIGHT });
  const touch = useRef({ x: 0, y: 0, grab: 0, dragging: false });
  const pan = usePanGesture({
    runOnJS: true,
    enabled: enabled && (!!onHold || !!reorder),
    activateAfterLongPress: HOLD_MS,
    onActivate: event => {
      touch.current = { x: event.absoluteX, y: event.absoluteY, grab: event.y, dragging: false };
      haptic.hold();
      onHold?.(index, { x: event.absoluteX - event.x, y: event.absoluteY - event.y, width: size.current.width, height: size.current.height });
    },
    onUpdate: event => {
      if (!reorder) return;
      if (!touch.current.dragging) {
        if (Math.hypot(event.absoluteX - touch.current.x, event.absoluteY - touch.current.y) <= STILL) return;
        touch.current.dragging = true;
        closeMenu();
        reorder.controller.current.begin(index, event.absoluteY, touch.current.grab, true);
      }
      reorder.controller.current.move(event.absoluteY);
    },
    onDeactivate: event => {
      if (touch.current.dragging) reorder?.controller.current.end(!event.canceled);
      touch.current.dragging = false;
    },
    onFinalize: event => {
      if (event.canceled && touch.current.dragging) reorder?.controller.current.cancel();
      touch.current.dragging = false;
    },
  });
  const style = useAnimatedStyle(() => {
    const start = from.get();
    const end = to.get();
    if (start < 0) return { opacity: 1, transform: [{ translateY: withTiming(0, { duration: 0 }) }] };
    const shift = index === start ? 0
      : start < end && index > start && index <= end ? -ROW_HEIGHT
      : start > end && index >= end && index < start ? ROW_HEIGHT : 0;
    return { opacity: index === start ? 0 : 1, transform: [{ translateY: withTiming(shift, { duration: 180, easing: Easing.bezier(0.2, 0.7, 0.2, 1) }) }] };
  });
  return (
    <GestureDetector gesture={pan}>
      <Animated.View collapsable={false} onLayout={event => { size.current = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height }; }} style={style}>{children}</Animated.View>
    </GestureDetector>
  );
}

/** `ids` with the item at `from` moved to `to`. */
export function moved<T>(ids: T[], from: number, to: number): T[] {
  const next = [...ids];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

const styles = StyleSheet.create({
  lifted: {
    position: "absolute",
    left: 12,
    right: 12,
    height: ROW_HEIGHT,
    borderRadius: radius.md,
    backgroundColor: "#0e0e0e",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.12)",
    shadowColor: "black",
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
});

