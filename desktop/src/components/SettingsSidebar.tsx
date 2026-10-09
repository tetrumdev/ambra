import "./SettingsView.css";
export type SettingsTab = "outputs" | "dsp" | "general";
export function SettingsSidebar({ tab, onSelect, onBack }: { tab: SettingsTab; onSelect: (tab: SettingsTab) => void; onBack: () => void }) {
  return <aside className="settingsSidebar" aria-label="Settings navigation">
    <button type="button" onClick={onBack}>Back to library</button>
    <h2>Settings</h2>
    <nav>{([{ id: "outputs", name: "Outputs" }, { id: "dsp", name: "DSP" }, { id: "general", name: "General" }] as const).map(item =>
      <button type="button" key={item.id} id={`settings-tab-${item.id}`} aria-current={tab === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}>{item.name}</button>)}</nav>
  </aside>;
}
