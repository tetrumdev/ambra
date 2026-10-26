import type { LyricSegment } from "../types/lyrics";

/**
 * Letter motion for word-synced lyrics.
 *
 * Timing only decides where each letter wants to be; springs decide how it gets
 * there. That keeps motion fluid however fast a word is sung, and seeking or
 * pausing never makes a letter jump. Tune the look here, not in the renderer.
 */

export type SpringConfig = { stiffness: number; damping: number };
export type Spring = { value: number; velocity: number };

/**
 * Line scrolling as a ripple: every line follows the scroll on its own spring and
 * sets off a beat after the one above it, so a line change pulls the lines up one
 * by one instead of sliding the page as a block.
 */
/** Soft and a touch under critical, so each line glides in and settles with a faint overshoot. */
export const rippleSpring: SpringConfig = { stiffness: 90, damping: 16 };
/** Delay between neighbouring lines setting off. */
/**
 * Share of the background left visible beside the artwork by #lyricsPage's
 * gradient in LyricsView.css (about 41% black where the cover sits).
 */
export const LYRICS_COVER_DIM = 0.59;

export const RIPPLE_STAGGER_MS = 75;
/** Lines further than this from where the wave starts share the last delay. */
export const RIPPLE_MAX_LINES = 9;

/** Near-critically damped: letters float up and settle without wobble. */
const liftSpring: SpringConfig = { stiffness: 120, damping: 22 };
/** Slightly softer than critical, so a swell blooms rather than snaps. */
const swellSpring: SpringConfig = { stiffness: 170, damping: 22 };
const glowSpring: SpringConfig = { stiffness: 90, damping: 19 };
/** Held notes already follow a smooth wave, so their spring only rounds it off. */
const waveSpring: SpringConfig = { stiffness: 320, damping: 34 };

/** Lift in em once a letter has been sung. */
const LIFT_EM = 0.045;
/** Extra lift for a held note while it rings. */
const EMPHASIS_LIFT_EM = 0.035;
/** Peak scale added as the sweep passes an ordinary letter. */
const SWELL = 0.025;
/** Peak scale added across a held note. */
const EMPHASIS_SWELL = 0.09;
/** Held notes at least this long, on short words, get the emphasis treatment. */
const EMPHASIS_MIN_MS = 1000;
const EMPHASIS_MAX_LETTERS = 10;
/** The swell starts slightly ahead of the sweep and lingers after it. */
const SWELL_LEAD_MS = 60;
const SWELL_TAIL_MS = 180;
/** Width of a held note's crest, in letters; neighbours rise and fall with it. */
const WAVE_WIDTH = 1.15;
/** Share of the crest a letter keeps once the wave has passed, until the note ends. */
const WAVE_WAKE = 0.45;
const WAVE_RELEASE_MS = 450;

const clamp01 = (value: number) => { "worklet"; return Math.min(1, Math.max(0, value)); };
const smoothstep = (value: number) => {
  "worklet";
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

/**
 * A held note as one continuous wave: a crest rides the sweep and lifts the letters
 * around it, letters behind it stay partly raised, and the whole shape breathes in
 * with the note and out after it. Returns 0..1 for this letter.
 */
function heldWave({ segment, index, count }: LetterMotion, timeMs: number): { swell: number; lift: number } {
  "worklet";
  const start = segment.startMs!;
  const duration = Math.max(1, (segment.endMs ?? start) - start);
  const sweep = ((timeMs - start) / duration) * count;
  const distance = index + 0.5 - sweep;
  const crest = Math.exp(-(distance * distance) / (2 * WAVE_WIDTH * WAVE_WIDTH));
  const wake = WAVE_WAKE * smoothstep(-distance / 1.5);
  const attack = Math.min(450, Math.max(200, duration * 0.25));
  const envelope =
    smoothstep((timeMs - start + SWELL_LEAD_MS) / attack) *
    (1 - smoothstep((timeMs - start - duration) / WAVE_RELEASE_MS));
  // Slower letters ring a little bigger.
  const strength = Math.min(1, Math.max(0.6, duration / count / 350));
  return {
    swell: envelope * strength * Math.max(crest, wake),
    lift: smoothstep(sweep - index),
  };
}

export type LetterMotion = {
  segment: LyricSegment;
  index: number;
  count: number;
  emphasis: boolean;
  lift: Spring;
  swell: Spring;
  glow: Spring;
  transform: string;
  filter: string;
};

export function letterMotion(segment: LyricSegment, index: number, count: number): LetterMotion {
  const duration = segment.startMs !== null && segment.endMs !== null ? segment.endMs - segment.startMs : 0;
  const letters = segment.text.trim().length;
  return {
    segment,
    index,
    count,
    emphasis: duration >= EMPHASIS_MIN_MS && letters > 0 && letters <= EMPHASIS_MAX_LETTERS,
    lift: { value: 0, velocity: 0 },
    swell: { value: 0, velocity: 0 },
    glow: { value: 0, velocity: 0 },
    transform: "",
    filter: "",
  };
}

/** Sweep position in letter widths from this letter's leading edge. */
export function letterHead({ segment, index, count }: LetterMotion, timeMs: number): number {
  "worklet";
  if (segment.startMs === null) return -1;
  if (segment.endMs === null || segment.endMs <= segment.startMs) return timeMs >= segment.startMs ? 2 : -1;
  return ((timeMs - segment.startMs) / (segment.endMs - segment.startMs)) * count - index;
}

/** Whether a held note is still breathing out after its line has ended. */
export function releasing({ segment, emphasis }: LetterMotion, timeMs: number): boolean {
  "worklet";
  return emphasis && segment.endMs !== null && timeMs < segment.endMs + WAVE_RELEASE_MS;
}

function targets(letter: LetterMotion, timeMs: number, lineActive: boolean) {
  "worklet";
  const { segment, index, count } = letter;
  if (segment.startMs === null) return { lift: 0, swell: 0, glow: 0 };
  if (!lineActive) {
    // A held note that ends its line lets its wave run out instead of dropping with the line.
    if (!releasing(letter, timeMs) || timeMs < segment.startMs) return { lift: 0, swell: 0, glow: 0 };
    const wave = heldWave(letter, timeMs);
    return { lift: 0, swell: wave.swell, glow: wave.swell };
  }
  const duration = segment.endMs === null ? 0 : Math.max(0, segment.endMs - segment.startMs);
  const start = segment.startMs + (duration * index) / count;
  const end = segment.startMs + (duration * (index + 1)) / count;
  const reached = timeMs >= start;
  if (letter.emphasis) {
    const wave = heldWave(letter, timeMs);
    return { lift: wave.lift, swell: wave.swell, glow: wave.swell };
  }
  const crossing = timeMs >= start - SWELL_LEAD_MS && timeMs < end + SWELL_TAIL_MS;
  return { lift: reached ? 1 : 0, swell: crossing ? 1 : 0, glow: 0 };
}

/** Portable targets for native renderers; desktop keeps integrating the same goals below. */
export function letterVisuals(letter: LetterMotion, timeMs: number, lineActive: boolean) {
  "worklet";
  const goal = targets(letter, timeMs, lineActive);
  return {
    head: letterHead(letter, timeMs),
    lift: goal.lift * LIFT_EM + goal.swell * (letter.emphasis ? EMPHASIS_LIFT_EM : 0),
    scale: 1 + goal.swell * (letter.emphasis ? EMPHASIS_SWELL : SWELL),
    glow: goal.glow,
  };
}

export const letterSprings = { lift: liftSpring, swell: swellSpring, wave: waveSpring, glow: glowSpring };

export function advanceSpring(spring: Spring, target: number, config: SpringConfig, seconds: number): boolean {
  "worklet";
  // Fixed substeps keep the spring stable through dropped frames.
  const steps = Math.max(1, Math.ceil(seconds * 240));
  const dt = seconds / steps;
  for (let i = 0; i < steps; i++) {
    spring.velocity += ((target - spring.value) * config.stiffness - spring.velocity * config.damping) * dt;
    spring.value += spring.velocity * dt;
  }
  if (Math.abs(target - spring.value) < 0.0005 && Math.abs(spring.velocity) < 0.005) {
    spring.value = target;
    spring.velocity = 0;
    return false;
  }
  return true;
}

/**
 * Advances one letter and writes its style. Returns whether it is still moving.
 * `snap` jumps straight to the resting pose, for seeks and first paint.
 */
export function animateLetter(
  letter: LetterMotion,
  element: HTMLElement,
  timeMs: number,
  lineActive: boolean,
  seconds: number,
  snap: boolean,
): boolean {
  const goal = targets(letter, timeMs, lineActive);
  let moving = false;
  if (snap) {
    // After a seek, show the settled pose; swells rebuild from rest as the sweep moves on.
    letter.lift = { value: goal.lift, velocity: 0 };
    letter.swell = { value: 0, velocity: 0 };
    letter.glow = { value: 0, velocity: 0 };
  } else {
    moving = advanceSpring(letter.lift, goal.lift, liftSpring, seconds) || moving;
    moving = advanceSpring(letter.swell, goal.swell, letter.emphasis ? waveSpring : swellSpring, seconds) || moving;
    moving = advanceSpring(letter.glow, goal.glow, glowSpring, seconds) || moving;
  }
  const lift = letter.lift.value * LIFT_EM + letter.swell.value * (letter.emphasis ? EMPHASIS_LIFT_EM : 0);
  const scale = 1 + letter.swell.value * (letter.emphasis ? EMPHASIS_SWELL : SWELL);
  const transform =
    lift > 0.0005 || scale > 1.0005 ? `translate3d(0, ${(-lift).toFixed(4)}em, 0) scale(${scale.toFixed(4)})` : "";
  if (transform !== letter.transform) {
    letter.transform = transform;
    element.style.transform = transform;
  }
  const glow = Math.max(0, letter.glow.value);
  const filter = glow > 0.01 ? `drop-shadow(0 0 0.18em rgba(255, 255, 255, ${(glow * 0.5).toFixed(3)}))` : "";
  if (filter !== letter.filter) {
    letter.filter = filter;
    element.style.filter = filter;
  }
  return moving;
}

/** Clears any motion, for reduced-motion mode. */
export function restLetter(letter: LetterMotion, element: HTMLElement) {
  letter.lift = { value: 0, velocity: 0 };
  letter.swell = { value: 0, velocity: 0 };
  letter.glow = { value: 0, velocity: 0 };
  if (letter.transform) element.style.transform = "";
  if (letter.filter) element.style.filter = "";
  letter.transform = "";
  letter.filter = "";
}

/**
 * Breathing dots for instrumental breaks. Like letters, timing only sets where each
 * dot wants to be and springs carry it there, so the dots bloom in one after another,
 * fill smoothly through the break and settle out instead of snapping between states.
 */
export type DotMotion = { appear: Spring; fill: Spring; style: string; shadow: string };

/** Soft enough that a dot blooms in with a faint overshoot. */
const dotAppearSpring: SpringConfig = { stiffness: 140, damping: 17 };
const dotFillSpring: SpringConfig = { stiffness: 60, damping: 15 };
/** Delay between neighbouring dots blooming in. */
const DOT_STAGGER_MS = 110;
/** Length of one breath; the swell is tied to song time, so it holds still while paused. */
const DOT_BREATH_MS = 2400;
const DOT_BREATH_SCALE = 0.16;
/** Centre-to-centre distance between dots, in em; matches .lyricPauseDot width plus the row gap. */
const DOT_PITCH_EM = 0.62;
/** A softer wave rolls through the dots between breaths, so they never sit still. */
const DOT_WAVE_MS = 1500;
/** Phase lag between neighbouring dots, so the wave travels left to right. */
const DOT_WAVE_LAG = 0.85;
const DOT_WAVE_LIFT_EM = 0.05;
const DOT_WAVE_SCALE = 0.08;
/** The dots finish fading this long before the next line starts. */
export const DOT_EXIT_MS = 600;

export function dotMotion(): DotMotion {
  return { appear: { value: 0, velocity: 0 }, fill: { value: 0, velocity: 0 }, style: "", shadow: "" };
}

/**
 * Advances one dot of a break and writes its style. Returns whether it is still moving.
 * `snap` jumps straight to the resting pose, for seeks, first paint and reduced motion.
 */
export function animateDot(
  dot: DotMotion,
  element: HTMLElement,
  index: number,
  count: number,
  timeMs: number,
  startMs: number,
  endMs: number,
  seconds: number,
  snap: boolean,
  breathe: boolean,
): boolean {
  const active = timeMs >= startMs && timeMs < endMs;
  const shown = active && timeMs < endMs - DOT_EXIT_MS && timeMs >= startMs + index * DOT_STAGGER_MS;
  const progress = clamp01((timeMs - startMs) / Math.max(1, endMs - startMs - DOT_EXIT_MS));
  const fillTarget = active ? smoothstep(progress * count - index) : 0;
  let moving = false;
  if (snap) {
    dot.appear = { value: active && timeMs < endMs - DOT_EXIT_MS ? 1 : 0, velocity: 0 };
    dot.fill = { value: fillTarget, velocity: 0 };
  } else {
    moving = advanceSpring(dot.appear, shown ? 1 : 0, dotAppearSpring, seconds) || moving;
    moving = advanceSpring(dot.fill, fillTarget, dotFillSpring, seconds) || moving;
  }
  const appear = Math.max(0, dot.appear.value);
  const elapsed = timeMs - startMs;
  // Breathe in from rest as the break starts, so the swell never starts mid-breath.
  const breath = breathe && active ? (1 - Math.cos((elapsed / DOT_BREATH_MS) * Math.PI * 2)) / 2 : 0;
  // The row breathes as one from its left edge, so dots spread apart as they swell.
  const group = 1 + DOT_BREATH_SCALE * breath;
  const wave = breathe && active ? Math.sin((elapsed / DOT_WAVE_MS) * Math.PI * 2 - index * DOT_WAVE_LAG) : 0;
  const fill = clamp01(dot.fill.value);
  const scale =
    (0.55 + 0.45 * appear) * (0.85 + 0.15 * fill) * group * (1 + DOT_WAVE_SCALE * appear * (0.5 + 0.5 * wave));
  const x = index * DOT_PITCH_EM * (group - 1);
  const y = -DOT_WAVE_LIFT_EM * appear * wave;
  const opacity = Math.min(1, appear) * (0.3 + 0.7 * fill);
  const style = `translate3d(${x.toFixed(4)}em, ${y.toFixed(4)}em, 0) scale(${scale.toFixed(4)})`;
  if (style !== dot.style) {
    dot.style = style;
    element.style.transform = style;
  }
  // The dot filling right now glows, so the eye can follow the break counting down.
  const glow = Math.min(1, appear) * 4 * fill * (1 - fill);
  const shadow = glow > 0.02 ? `0 0 0.35em rgba(255, 255, 255, ${(glow * 0.55).toFixed(3)})` : "";
  const opacityText = opacity.toFixed(3);
  if (element.style.opacity !== opacityText) element.style.opacity = opacityText;
  if (shadow !== dot.shadow) {
    dot.shadow = shadow;
    element.style.boxShadow = shadow;
  }
  return moving;
}
