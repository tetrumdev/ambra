import { spring, type SpringTiming } from "./spring";

// Ambra's motion language. Views and large surfaces leave gently and settle quietly over a
// long tail; things you touch respond at once and spring back. Every animation uses one of these, from TS directly or
// from CSS through the custom properties installed below:
//   --motion-<name>            "<duration> <easing>", for transition/animation shorthands
//   --motion-<name>-duration
//   --motion-<name>-ease

export const motion = {
  /** Views and large surfaces moving or fading: the player opening and closing, the bar
      reshaping, lyrics and covers changing places. A gentle start, then a long quiet settle. */
  smooth: { duration: 500, easing: "cubic-bezier(0.4, 0, 0, 1)" },
  /** A screen or page arriving: nearly there at once, then a short settle, so navigating never waits. */
  enter: { duration: 260, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  /** Things lighting up under the pointer. Leaving takes twice as long, so they fade rather than blink off. */
  hover: { duration: 120, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  /** Small controls changing shape or place: chevrons turning, the search field widening. */
  snappy: spring(0.35, 0.9, "cubic-bezier(0.25, 1, 0.5, 1)"),
  /** A pressed control going down: immediate. */
  pressDown: { duration: 90, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  /** A pressed control coming back up, with a small spring past its resting size. */
  pressUp: spring(0.32, 0.6, "cubic-bezier(0.34, 1.56, 0.64, 1)"),
} satisfies Record<string, SpringTiming>;

const root = document.documentElement.style;
for (const [name, { duration, easing }] of Object.entries(motion)) {
  const token = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  root.setProperty(`--motion-${token}`, `${duration}ms ${easing}`);
  root.setProperty(`--motion-${token}-duration`, `${duration}ms`);
  root.setProperty(`--motion-${token}-ease`, easing);
}
