import "./PlayerControls.css";
import { useRef, useState } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { MorphSVGPlugin } from "gsap/MorphSVGPlugin";
import { CustomEase } from "gsap/CustomEase";
import { motion } from "../utils/motion";
import { reducedMotion } from "../utils/reducedMotion";

gsap.registerPlugin(useGSAP, MorphSVGPlugin, CustomEase);

const skipEase = CustomEase.create("", motion.smooth.easing.slice("cubic-bezier(".length, -1));

// Play is split down the middle into two halves that fold into the pause bars,
// so every corner has a partner and the icon morphs instead of swapping. The left
// half runs past the split along the triangle's edges so the anti-aliased seam is covered.
const shapes = {
  play: ["M5 3L13.2 7.73L13.2 16.27L5 21Z", "M12.8 7.5L20.6 12L20.6 12L12.8 16.5Z"],
  pause: ["M5.5 3L9.75 3L9.75 21L5.5 21Z", "M14.25 3L18.5 3L18.5 21L14.25 21Z"],
};

function PlayPauseIcon({ playing }: { playing: boolean }) {
  const icon = useRef<SVGSVGElement>(null);
  const first = useRef(true);
  // React draws the first shape only; GSAP owns the paths from then on, so a re-render never cuts a morph short.
  const [initial] = useState(() => shapes[playing ? "pause" : "play"]);
  useGSAP(() => {
    const target = shapes[playing ? "pause" : "play"];
    const paths = icon.current!.querySelectorAll("path");
    const reduced = reducedMotion();
    paths.forEach((path, index) => {
      if (first.current || reduced) gsap.set(path, { attr: { d: target[index] } });
      else gsap.to(path, { morphSVG: target[index], duration: 0.32, ease: "power3.inOut", overwrite: true });
    });
    first.current = false;
  }, { dependencies: [playing], scope: icon });
  return (
    <svg ref={icon} viewBox="3 3 18 18" aria-hidden="true">
      {initial.map((d, index) => <path key={index} d={d} fill="white" />)}
    </svg>
  );
}

function SkipIcon({ backwards = false, activation }: { backwards?: boolean; activation: number }) {
  const icon = useRef<SVGSVGElement>(null);
  const seenActivation = useRef(activation);
  const animation = useRef<gsap.core.Timeline | null>(null);
  useGSAP(() => {
    if (seenActivation.current === activation) return;
    seenActivation.current = activation;
    animation.current?.progress(1).kill();
    if (reducedMotion()) return;

    const paths = icon.current!.querySelectorAll("path");
    // Three triangles roll through two visible positions. Resetting at the end
    // swaps identical shapes, ready for the next activation without a visible jump.
    const reset = () => {
      gsap.set(paths, { x: 0, scale: 1, transformOrigin: "50% 50%" });
      gsap.set(paths[0], { opacity: 0, scale: 0 });
      gsap.set(paths[2], { opacity: 1 });
    };
    reset();
    animation.current = gsap.timeline({
      defaults: { duration: motion.smooth.duration / 1000, ease: skipEase },
      onComplete: reset,
    })
      .to(paths, { x: 191.25 }, 0)
      .to(paths[0], { opacity: 1, scale: 1 }, 0)
      .to(paths[2], { opacity: 0, scale: 0 }, 0);
  }, { dependencies: [activation], scope: icon });
  return (
    <svg ref={icon} className="skipIcon" viewBox="0 0 430 276" aria-hidden="true">
      <g transform={backwards ? "translate(430 276) rotate(180)" : undefined} fill="white">
        <path d="M-191.25 0L47.5 138L-191.25 276Z" opacity="0" />
        <path d="M0 0L238.75 138L0 276Z" />
        <path d="M191.25 0L430 138L191.25 276Z" />
      </g>
    </svg>
  );
}

type PlayerControlsProps = {
  isPlaying: boolean;
  previousActivation: number;
  nextActivation: number;
  onPrevious: () => void;
  onTogglePlayback: () => void | Promise<void>;
  onNext: () => void;
  disabled?: boolean;
};

export function PlayerControls({
  isPlaying,
  previousActivation,
  nextActivation,
  onPrevious,
  onTogglePlayback,
  onNext,
  disabled = false,
}: PlayerControlsProps) {
  return (
    <div id="controls">
      <button
        id="backBtn"
        type="button"
        onClick={onPrevious}
        disabled={disabled}
        data-tooltip="Previous"
        aria-label="Previous"
      >
        <SkipIcon backwards activation={previousActivation} />
      </button>

      <button
        id="playBtn"
        type="button"
        onClick={onTogglePlayback}
        className={isPlaying ? "pause" : "play"}
        disabled={disabled}
        data-tooltip={isPlaying ? "Pause" : "Play"}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        <PlayPauseIcon playing={isPlaying} />
      </button>

      <button id="skipBtn" type="button" onClick={onNext} disabled={disabled} data-tooltip="Next" aria-label="Next">
        <SkipIcon activation={nextActivation} />
      </button>
    </div>
  );
}
