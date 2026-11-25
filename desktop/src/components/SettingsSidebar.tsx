import "./SettingsView.css";
export type SettingsTab = "general" | "appearance" | "lyrics" | "outputs" | "dsp" | "services" | "server" | "local" | "keyboard" | "about";

const tabs: Array<{ id: SettingsTab; name: string }> = [
  { id: "general", name: "General" },
  { id: "appearance", name: "Appearance" },
  { id: "lyrics", name: "Lyrics" },
  { id: "outputs", name: "Outputs" },
  { id: "dsp", name: "DSP" },
  { id: "services", name: "Services" },
  { id: "server", name: "Server" },
  { id: "local", name: "Local" },
  { id: "keyboard", name: "Keyboard" },
  { id: "about", name: "About" },
];

export function SettingsSidebar({ tab, onSelect }: { tab: SettingsTab; onSelect: (tab: SettingsTab) => void }) {
  return <aside className="settingsSidebar" aria-label="Settings navigation">
    <h2>Settings</h2>
    <nav>{tabs.map(item =>
      <button type="button" key={item.id} id={`settings-tab-${item.id}`} className="sidebarBtn"
        aria-current={tab === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}>{item.name}</button>)}</nav>
  </aside>;
}
