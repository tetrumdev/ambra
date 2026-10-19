// A damped spring as an animation timing, described the way SwiftUI describes its springs:
// `response` is the period, in seconds, the spring would swing at without damping, and
// `dampingFraction` is how much of the swing is damped away (1 settles without overshoot).
// The curve is sampled into a CSS `linear()` easing, so it runs on the compositor like any
// other timing function.

const SAMPLES = 60;
/** How close to rest counts as settled; below this the motion is under a pixel. */
const REST = 0.001;

export type SpringTiming = { duration: number; easing: string };

export function spring(response: number, dampingFraction: number, fallback: string): SpringTiming {
  const omega = (2 * Math.PI) / response;
  const decay = dampingFraction * omega;
  const damped = omega * Math.sqrt(Math.max(0, 1 - dampingFraction * dampingFraction));
  const position = (t: number) => damped > 0
    ? 1 - Math.exp(-decay * t) * (Math.cos(damped * t) + (decay / damped) * Math.sin(damped * t))
    : 1 - Math.exp(-omega * t) * (1 + omega * t);
  // Settled after the last moment the spring is still further than the rest threshold from its target.
  const step = 1 / 600;
  let seconds = step;
  for (let t = step; t < response * 10; t += step) if (Math.abs(1 - position(t)) > REST) seconds = t + step;
  const duration = Math.round(seconds * 1000);
  if (!CSS.supports("animation-timing-function", "linear(0, 1)")) return { duration, easing: fallback };
  const points = Array.from({ length: SAMPLES + 1 }, (_, index) =>
    index === SAMPLES ? 1 : Number(position((index / SAMPLES) * seconds).toFixed(4)));
  return { duration, easing: `linear(${points.join(", ")})` };
}
