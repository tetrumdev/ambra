import { invoke, isTauri } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { SettingRow } from "./SettingsControls";

type Props = {
  onRescanLocalMusic: () => Promise<number>;
};

export function LocalSettings({ onRescanLocalMusic }: Props) {
  const [busy, setBusy] = useState<"local" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openImportFolder() {
    setBusy("local");
    setError(null);
    setMessage(null);
    try {
      if (!isTauri()) throw new Error("Local imports are available in the desktop app.");
      const directory = await invoke<string>("local_music_directory");
      await openPath(directory);
      setMessage("Add audio files to the Ambra folder, then choose Scan now.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function rescan() {
    setBusy("local");
    setError(null);
    setMessage(null);
    try {
      const count = await onRescanLocalMusic();
      setMessage(`Local library updated — ${count} ${count === 1 ? "track" : "tracks"} found.`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <header className="settingsPageHeader"><h1 className="settingsTitle">Local</h1></header>
      <div className="settingsGroup">
        <h2>Local music</h2>
        <SettingRow label="Music folder" hint="Files in Music/Ambra are copied into your server's library when imported.">
          <button type="button" className="settingsPill" onClick={() => void openImportFolder()} disabled={busy === "local"}>
            Open folder
          </button>
        </SettingRow>
        <SettingRow label="Import music" hint="Copy new or changed files to the server. Imported music stays there when this computer disconnects.">
          <button type="button" className="settingsPill" onClick={() => void rescan()} disabled={busy === "local"}>
            {busy === "local" ? "Working…" : "Scan now"}
          </button>
        </SettingRow>
        {message && <p className="settingsMuted" role="status">{message}</p>}
        {error && <p className="settingsError" role="alert">{error}</p>}
      </div>
    </>
  );
}
