import "./SettingsView.css";
export type SettingsTab = "general" | "outputs" | "dsp" | "services" | "server" | "local";

const tabs: Array<{ id: SettingsTab; name: string }> = [
  { id: "general", name: "General" },
  { id: "outputs", name: "Outputs" },
  { id: "dsp", name: "DSP" },
  { id: "services", name: "Services" },
  { id: "server", name: "Server" },
  { id: "local", name: "Local" },
];

export function SettingsSidebar({ tab, onSelect, onBack }: { tab: SettingsTab; onSelect: (tab: SettingsTab) => void; onBack: () => void }) {
  return <aside className="settingsSidebar" aria-label="Settings navigation">
    <button type="button" className="settingsBack" onClick={onBack}>
      <svg viewBox="0 0 8 12" aria-hidden="true"><path d="M6.5 1 1.5 6l5 5" /></svg>Library
    </button>
    <h2>Settings</h2>
    <nav>{tabs.map(item =>
      <button type="button" key={item.id} id={`settings-tab-${item.id}`} className="sidebarBtn"
        aria-current={tab === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}>{item.name}</button>)}</nav>
  </aside>;
}
