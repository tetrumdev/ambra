import { flushSync } from "react-dom";

const duration = 400;
const easing = "ease-in-out";
const movingElementSelectors = [
  "#songInfo",
  "#controls",
  "#progressContainer",
] as const;

function getRects() {
  return new Map(
    movingElementSelectors.flatMap((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element ? [[selector, element.getBoundingClientRect()] as const] : [];
    }),
  );
}

export function runLayoutTransition(update: () => void) {
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const bar = document.querySelector<HTMLElement>("#bottomInfoBar");

  if (!bar?.animate || prefersReducedMotion) {
    flushSync(update);
    return;
  }

  const beforeHeight = bar.getBoundingClientRect().height;
  const beforeRects = getRects();
  const hadCompactArtwork = Boolean(document.querySelector("#compactArtwork"));

  flushSync(update);

  const nextBar = document.querySelector<HTMLElement>("#bottomInfoBar");
  if (!nextBar) return;

  const afterHeight = nextBar.getBoundingClientRect().height;
  const options: KeyframeAnimationOptions = { duration, easing };
  const animations: Animation[] = [];

  const heightAnimation = nextBar.animate(
    [
      { height: `${beforeHeight}px` },
      { height: `${afterHeight}px` },
    ],
    options,
  );
  heightAnimation.pause();
  heightAnimation.currentTime = 0;
  animations.push(heightAnimation);

  for (const selector of movingElementSelectors) {
    const beforeRect = beforeRects.get(selector);
    const element = document.querySelector<HTMLElement>(selector);
    if (!beforeRect || !element) continue;

    const animatedStartRect = element.getBoundingClientRect();
    const x = beforeRect.left - animatedStartRect.left;
    const y = beforeRect.top - animatedStartRect.top;
    const animation = element.animate(
      [
        { transform: `translate(${x}px, ${y}px)` },
        { transform: "translate(0, 0)" },
      ],
      options,
    );
    animation.pause();
    animation.currentTime = 0;
    animations.push(animation);
  }

  const enteringArtwork = document.querySelector<HTMLElement>("#compactArtwork");
  if (enteringArtwork && !hadCompactArtwork) {
    const artworkAnimation = enteringArtwork.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      options,
    );
    artworkAnimation.pause();
    artworkAnimation.currentTime = 0;
    animations.push(artworkAnimation);
  }

  for (const animation of animations) animation.play();
}
