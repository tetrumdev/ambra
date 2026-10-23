import { useId, type KeyboardEvent, type ReactNode } from "react";

/** One setting: its name and an optional short hint on the left, its control on the right. */
export function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const hintId = useId();
  return <div className="settingRow">
    <div className="settingRowText">
      <span className="settingRowLabel">{label}</span>
      {hint && <span className="settingRowHint" id={hintId}>{hint}</span>}
    </div>
    <div className="settingRowControl" aria-describedby={hint ? hintId : undefined}>{children}</div>
  </div>;
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
