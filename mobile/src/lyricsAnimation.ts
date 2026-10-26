import { advanceSpring, DOT_EXIT_MS, letterSprings, letterVisuals, RIPPLE_MAX_LINES, RIPPLE_STAGGER_MS, rippleSpring, type LetterMotion, type Spring } from "../../desktop/src/utils/lyricsMotion";

export const lyricFontSize = (width: number) => Math.min(48, Math.max(34, width * 0.1)) * 1.15 * 0.95;

/** Small position reports correct the running clock without moving a sung letter backward. */
export function lyricClockStep(current: number, sampled: number, seconds: number, playing: boolean) {
  "worklet";
  const advance = seconds * 1000;
  const error = sampled - current - advance;
  if (!Number.isFinite(current) || !playing || Math.abs(error) > 350) return sampled;
  return Math.max(current, current + advance + Math.min(advance * 0.15, Math.max(-advance * 0.15, error)));
}

export type NativeLetter = { motion: LetterMotion; lift: Spring; scale: Spring; glow: Spring; head: number };
export function nativeLetter(motion: LetterMotion): NativeLetter {
  return { motion, lift: { value: 0, velocity: 0 }, scale: { value: 1, velocity: 0 }, glow: { value: 0, velocity: 0 }, head: 0 };
}

export type NativeDot = { appear: Spring; fill: Spring; opacity: number; scale: number; x: number; y: number };
export const nativeDot = (): NativeDot => ({ appear: { value: 0, velocity: 0 }, fill: { value: 0, velocity: 0 }, opacity: 0, scale: 0.55, x: 0, y: 0 });
export function advanceNativeDot(dot: NativeDot, index: number, time: number, start: number, end: number, seconds: number, reduced: boolean) {
  "worklet";
  const elapsed = time - start;
  const active = time >= start && time < end;
  const shown = active && time < end - DOT_EXIT_MS && elapsed >= index * 110;
  const progress = Math.min(1, Math.max(0, elapsed / Math.max(1, end - start - DOT_EXIT_MS) * 3 - index));
  const fill = active ? progress * progress * (3 - 2 * progress) : 0;
  if (reduced) {
    dot.appear.value = shown ? 1 : 0;
    dot.fill.value = fill;
    dot.appear.velocity = dot.fill.velocity = 0;
  } else {
    advanceSpring(dot.appear, shown ? 1 : 0, { stiffness: 140, damping: 17 }, seconds);
    advanceSpring(dot.fill, fill, { stiffness: 60, damping: 15 }, seconds);
  }
  const appear = Math.max(0, dot.appear.value);
  const filled = Math.min(1, Math.max(0, dot.fill.value));
  const breath = !reduced && active ? (1 - Math.cos(elapsed / 2400 * Math.PI * 2)) / 2 : 0;
  const spread = 1 + 0.16 * breath;
  const wave = !reduced && active ? Math.sin(elapsed / 1500 * Math.PI * 2 - index * 0.85) : 0;
  dot.opacity = Math.min(1, appear) * (0.3 + 0.7 * filled);
  dot.scale = (0.55 + 0.45 * appear) * (0.85 + 0.15 * filled) * spread * (1 + 0.08 * appear * (0.5 + 0.5 * wave));
  dot.x = reduced ? 0 : index * 22 * (spread - 1);
  dot.y = -1.8 * appear * wave;
}

/** One persistent spring per channel; never create a new animation on each clock tick. */
export function advanceNativeLetter(letter: NativeLetter, time: number, active: boolean, seconds: number, snap: boolean, reduced: boolean) {
  "worklet";
  const pose = letterVisuals(letter.motion, time, active);
  letter.head = Math.min(1, Math.max(0, (pose.head + 0.9) / 1.8));
  if (snap || reduced) {
    letter.lift.value = reduced ? 0 : pose.lift;
    letter.scale.value = 1;
    letter.glow.value = 0;
    letter.lift.velocity = letter.scale.velocity = letter.glow.velocity = 0;
    return !reduced && (pose.lift !== 0 || pose.scale !== 1);
  }
  const lift = advanceSpring(letter.lift, pose.lift, letterSprings.lift, seconds);
  const scale = advanceSpring(letter.scale, pose.scale, letter.motion.emphasis ? letterSprings.wave : letterSprings.swell, seconds);
  const glow = advanceSpring(letter.glow, pose.glow, letterSprings.glow, seconds);
  return lift || scale || glow;
}

export type LyricScrollGoal = { offset: number; focus: number; origin: number; epoch: number; snap: boolean };
export type LyricRipple = Spring & { goal: number; pending: number; releaseAt: number; epoch: number };
export type LyricScrollMotion = { offset: number; ripples: LyricRipple[] };
export const lyricRipple = (): LyricRipple => ({ value: 0, velocity: 0, goal: 0, pending: 0, releaseAt: 0, epoch: -1 });

/** Settled rows need no new shared snapshot or native view updates until the next target. */
export function lyricScrollSettled(state: LyricScrollMotion, target: LyricScrollGoal) {
  "worklet";
  return state.offset === target.offset && state.ripples.every(ripple => ripple.epoch === target.epoch
    && ripple.value === target.offset && ripple.velocity === 0 && ripple.pending === ripple.goal);
}

export function shouldAdvanceLyricRow(previous: { time: number; moving: boolean }, time: number, active: boolean, seconds: number) {
  "worklet";
  const snap = !Number.isFinite(previous.time) || time < previous.time - 50 || time - previous.time > Math.max(350, seconds * 1000 + 150);
  return { snap, advance: snap || previous.moving || (active && time !== previous.time) };
}

/** A neighbouring row follows one beat later, retaining momentum if another line starts mid-wave. */
export function advanceLyricRipple(state: LyricRipple, target: LyricScrollGoal, index: number, now: number, seconds: number, current: number, snap: boolean) {
  "worklet";
  if (snap || target.snap || state.epoch < 0) {
    state.value = state.goal = state.pending = current;
    state.velocity = 0;
    state.epoch = target.epoch;
    if (snap || target.snap) return;
  }
  if (target.epoch !== state.epoch || target.offset !== state.pending) {
    const direction = Math.sign(target.offset - state.pending);
    const rank = Math.min(RIPPLE_MAX_LINES, Math.max(0, direction >= 0 ? index - target.origin : target.origin - index));
    const releaseAt = now + rank * RIPPLE_STAGGER_MS;
    state.releaseAt = state.pending !== state.goal ? Math.min(state.releaseAt, releaseAt) : releaseAt;
    state.pending = target.offset;
    state.epoch = target.epoch;
  }
  if (now >= state.releaseAt) state.goal = state.pending;
  if (state.value !== state.goal || state.velocity) advanceSpring(state, state.goal, rippleSpring, seconds);
}

/** Keep the native scroll and all compensating transforms in one UI-frame snapshot. */
export function advanceLyricScrollMotion(state: LyricScrollMotion, target: LyricScrollGoal, now: number, seconds: number, nativeOffset: number, following: boolean, reduced: boolean) {
  "worklet";
  const offset = following ? target.offset : nativeOffset;
  for (let index = 0; index < state.ripples.length; index++) {
    advanceLyricRipple(state.ripples[index], target, index, now, seconds, offset, !following || reduced);
  }
  state.offset = offset;
}

/** Anchor the first visual line, rather than the centre of a tall wrapped stanza. */
export function lyricScrollTarget(top: number, anchor: number, viewport: number, content: number) {
  return Math.max(0, Math.min(Math.max(0, content - viewport), top + anchor - viewport * 0.43));
}
