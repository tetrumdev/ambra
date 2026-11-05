import { useRef, useState } from "react";
import type { AudioQuality, Track } from "../types/music";
import { signalPathQuality } from "../utils/audioQuality";
import { AudioControlsMenu } from "./AudioControlsMenu";
import "./QualityLight.css";

type QualityLightProps = {
  track: Track;
  audioQuality?: AudioQuality | null;
};

/** A colored light for the playing song's quality; clicking it shows the whole signal path. */
export function QualityLight({ track, audioQuality }: QualityLightProps) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const quality = signalPathQuality(track, audioQuality);
  return (
    <div className="qualityLight">
      <button
        ref={button}
        type="button"
        className="qualityLightButton"
        data-tier={quality.tier}
        aria-label={`Audio quality: ${quality.label}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-tooltip={open ? undefined : quality.label}
        onClick={() => setOpen(current => !current)}
      >
        <span className="qualityLightDot" aria-hidden="true" />
      </button>
      {open && (
        <AudioControlsMenu anchor={button} onClose={() => setOpen(false)} label="Signal path" align="center" className="qualityPanel">
          <div className="qualityPanelHeader" data-tier={quality.tier}>
            <span className="qualityLightDot" aria-hidden="true" />
            <span className="qualityPanelTitle">{quality.label}</span>
            {quality.tier === "bitPerfect" && <span className="qualityPanelSubtitle">{quality.name}</span>}
          </div>
          <dl className="qualityPanelRows">
            {quality.rows.map(row => (
              <div key={row.label} className="qualityPanelRow">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          {quality.note && <p className="qualityPanelNote">{quality.note}</p>}
        </AudioControlsMenu>
      )}
    </div>
  );
}
