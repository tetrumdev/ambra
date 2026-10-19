import "./PlayerControls.css";
import { useRef, useState } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { MorphSVGPlugin } from "gsap/MorphSVGPlugin";

gsap.registerPlugin(useGSAP, MorphSVGPlugin);

// Play is split down the middle into two halves that fold into the pause bars,
// so every corner has a partner and the icon morphs instead of swapping.
const shapes = {
  play: ["M5 3L12.8 7.5L12.8 16.5L5 21Z", "M12.8 7.5L20.6 12L20.6 12L12.8 16.5Z"],
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
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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

type PlayerControlsProps = {
  isPlaying: boolean;
  onPrevious: () => void;
  onTogglePlayback: () => void | Promise<void>;
  onNext: () => void;
  disabled?: boolean;
};

export function PlayerControls({
  isPlaying,
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
      >
        <img src="/back.svg" alt="Previous" />
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

      <button id="skipBtn" type="button" onClick={onNext} disabled={disabled} data-tooltip="Next">
        <img src="/skip.svg" alt="Next" />
      </button>
    </div>
  );
}
