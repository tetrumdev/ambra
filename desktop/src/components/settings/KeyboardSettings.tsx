import { useEffect, useState } from "react";
import {
  bindingFromEvent, formatBinding, isModifierCode, sameBinding, shortcutBindings, shortcutCategories, shortcutDefinition,
  shortcutIds, shortcutsUsing, suspendShortcuts, type ShortcutBinding, type ShortcutId, type ShortcutOverrides,
} from "../../utils/shortcuts";
import { SettingRow } from "./SettingsControls";

type Recording = { id: ShortcutId; index: number | "new" };

/** Every shortcut, its keys, and a way to record new ones. */
export function KeyboardSettings({ overrides, onChange }: { overrides: ShortcutOverrides; onChange: (overrides: ShortcutOverrides) => void }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  // What the last change took from another shortcut, so it doesn't vanish unnoticed.
  const [notice, setNotice] = useState<string | null>(null);
  const customized = shortcutIds.some(id => overrides[id] !== undefined);

  const setBindings = (id: ShortcutId, bindings: ShortcutBinding[], from = overrides) => {
    const next = { ...from };
    const defaults = shortcutDefinition(id).defaults;
    if (bindings.length === defaults.length && bindings.every((binding, index) => sameBinding(binding, defaults[index]))) delete next[id];
    else next[id] = bindings;
    return next;
  };

  useEffect(() => {
    if (!recording) return;
    suspendShortcuts(true);
    const record = (event: KeyboardEvent) => {
      if (isModifierCode(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      // Escape alone cancels; it can be given back to a shortcut with Reset.
      if (event.code === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        setRecording(null);
        return;
      }
      const binding = bindingFromEvent(event);
      let next = overrides;
      const taken = shortcutsUsing(binding, overrides, recording.id);
      for (const other of taken) {
        next = setBindings(other, shortcutBindings(other, next).filter(existing => !sameBinding(existing, binding)), next);
      }
      const current = shortcutBindings(recording.id, next).filter(existing => !sameBinding(existing, binding));
      const index = recording.index === "new" ? current.length : Math.min(recording.index, current.length);
      if (recording.index !== "new") current.splice(index, 1);
      current.splice(index, 0, binding);
      onChange(setBindings(recording.id, current, next));
      setNotice(taken.length ? `Removed from ${taken.map(id => `“${shortcutDefinition(id).label}”`).join(" and ")}` : null);
      setRecording(null);
    };
    const cancel = () => setRecording(null);
    window.addEventListener("keydown", record, true);
    window.addEventListener("blur", cancel);
    return () => {
      suspendShortcuts(false);
      window.removeEventListener("keydown", record, true);
      window.removeEventListener("blur", cancel);
    };
  }, [recording, overrides, onChange]);

  return <>
    <header className="settingsPageHeader">
      <h1 className="settingsTitle">Keyboard</h1>
      <button type="button" className="settingsPill" disabled={!customized} onClick={() => { onChange({}); setNotice(null); }}>Reset all</button>
    </header>
    <p className="settingsMuted">Click a shortcut, then press the keys for it. Esc cancels.</p>
    {notice && <p className="settingsMuted" role="status">{notice}</p>}
    {shortcutCategories.map(category => <div className="settingsGroup" key={category}>
      <h2>{category}</h2>
      {shortcutIds.filter(id => shortcutDefinition(id).category === category && !shortcutDefinition(id).unavailable).map(id => {
        const definition = shortcutDefinition(id);
        const bindings = shortcutBindings(id, overrides);
        const isRecording = (index: number | "new") => recording?.id === id && recording.index === index;
        return <SettingRow key={id} label={definition.label} hint={definition.hint}>
          <span className="shortcutBindings">
            {bindings.map((binding, index) => <span className="shortcutBinding" key={index} data-recording={isRecording(index) || undefined}>
              <button type="button" className="shortcutBindingKeys" aria-label={`Change ${definition.label} shortcut`}
                onClick={() => setRecording(isRecording(index) ? null : { id, index })}>
                {isRecording(index) ? "Press keys…" : formatBinding(binding)}
              </button>
              <button type="button" className="shortcutRemove" aria-label={`Remove ${definition.label} shortcut`}
                onClick={() => onChange(setBindings(id, bindings.filter((_, other) => other !== index)))}>×</button>
            </span>)}
            {!bindings.length && !isRecording("new") && <span className="settingsMuted">None</span>}
            <button type="button" className="shortcutAdd" data-recording={isRecording("new") || undefined}
              aria-label={`Add a ${definition.label} shortcut`} onClick={() => setRecording(isRecording("new") ? null : { id, index: "new" })}>
              {isRecording("new") ? "Press keys…" : "Add"}
            </button>
            {overrides[id] && <button type="button" className="settingsLink" onClick={() => onChange(setBindings(id, definition.defaults))}>Reset</button>}
          </span>
        </SettingRow>;
      })}
    </div>)}
  </>;
}
