import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useFadeOutOnUnmount } from "../../hooks/useFadeOutOnUnmount";
import { isUnmodifiedKey } from "../../utils/keyboard";

/**
 * One setting: its name on the left, its control on the right. `hint` is a short status shown
 * under the name (a version, an address); `help` explains the setting, behind a question mark.
 */
export function SettingRow({ label, hint, help, children }: { label: string; hint?: ReactNode; help?: ReactNode; children: ReactNode }) {
  const hintId = useId();
  return <div className="settingRow">
    <div className="settingRowText">
      <span className="settingRowLabel">{label}{help && <Help topic={label}>{help}</Help>}</span>
      {hint && <span className="settingRowHint" id={hintId}>{hint}</span>}
    </div>
    <div className="settingRowControl" aria-describedby={hint ? hintId : undefined}>{children}</div>
  </div>;
}

/**
 * A question mark beside a heading, shown while the heading is hovered or the mark has focus.
 * Clicking it opens what the heading means, in the app's glass, beside the mark.
 */
export function Help({ topic, children }: { topic: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={button} type="button" className="settingsHelp" aria-label={`About ${topic}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={event => { event.stopPropagation(); setOpen(current => !current); }}>?</button>
    {open && <HelpPopover anchor={button} topic={topic} onClose={() => { setOpen(false); button.current?.focus(); }}>{children}</HelpPopover>}
  </>;
}

function HelpPopover({ anchor, topic, onClose, children }: { anchor: RefObject<HTMLButtonElement | null>; topic: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useFadeOutOnUnmount(panel);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const mark = anchor.current;
    const element = panel.current;
    if (!mark || !element) return;
    const place = () => {
      const at = mark.getBoundingClientRect();
      const size = element.getBoundingClientRect();
      const left = Math.max(8, Math.min(at.left - 14, window.innerWidth - size.width - 8));
      // Below the mark, or above it where the window ends first.
      const below = at.bottom + 8;
      const top = below + size.height <= window.innerHeight - 8 ? below : Math.max(8, at.top - size.height - 8);
      setPosition(current => current?.left === left && current.top === top ? current : { left, top });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => { panel.current?.focus(); }, []);
  return createPortal(
    <div className="settingsHelpBackdrop" onClick={onClose} onKeyDown={event => {
      if (!isUnmodifiedKey(event, "Escape")) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}>
      <div ref={panel} className="settingsHelpPanel" role="dialog" aria-label={topic} tabIndex={-1}
        style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}
        onClick={event => event.stopPropagation()}>
        <strong>{topic}</strong>
        <div className="settingsHelpText">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <input type="checkbox" role="switch" className="settingsToggle" aria-label={label} checked={checked} disabled={disabled}
    onChange={event => onChange(event.currentTarget.checked)} />;
}

/** A few mutually exclusive choices, shown side by side like the player's own pills. */
export function Segmented<T extends string>({ label, value, options, disabled, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; disabled?: boolean; onChange: (value: T) => void;
}) {
  // Left and Right move the choice, as in any radio group.
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = options.findIndex(option => option.value === value);
    const next = options[(index + (event.key === "ArrowRight" ? 1 : options.length - 1)) % options.length];
    onChange(next.value);
    (event.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus();
  };
  return <div className="settingsSegmented" role="radiogroup" aria-label={label} onKeyDown={move}>
    {options.map(option => <button key={option.value} type="button" role="radio" data-value={option.value}
      aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1} disabled={disabled}
      onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
