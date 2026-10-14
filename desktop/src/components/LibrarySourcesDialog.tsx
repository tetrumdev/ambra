import { invoke, isTauri } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { closeDialog, openDialog } from "../utils/dialogs";

type Props = {
  onRescanLocalMusic: () => Promise<number>;
};

export function LibrarySourcesDialog({ onRescanLocalMusic }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"local" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) openDialog(dialog.current);
    else closeDialog(dialog.current);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

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
      <button
        ref={trigger}
        type="button"
        className="librarySourcesTrigger"
        aria-label="Add local music"
        data-tooltip="Add local music"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        +
      </button>
      <dialog
        ref={dialog}
        className="librarySourcesDialog"
        aria-labelledby="library-sources-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="librarySourcesPanel">
          <div className="librarySourcesHeading">
            <div>
              <h2 id="library-sources-title">Add to your library</h2>
              <p>Import local music into your library.</p>
            </div>
            <button type="button" className="librarySourcesClose" aria-label="Close" onClick={close}><img src="/x.svg" alt="" /></button>
          </div>

          <section className="librarySourceRow">
            <div>
              <h3>Local music</h3>
              <p>Files in Music/Ambra are added to your library.</p>
            </div>
            <div className="librarySourceActions">
              <button type="button" onClick={() => void openImportFolder()} disabled={busy === "local"}>
                Open folder
              </button>
              <button type="button" onClick={() => void rescan()} disabled={busy === "local"}>
                {busy === "local" ? "Working…" : "Scan now"}
              </button>
            </div>
          </section>

          {message && <p className="librarySourcesMessage" role="status">{message}</p>}
          {error && <p className="librarySourcesError" role="alert">{error}</p>}
        </div>
      </dialog>
    </>
  );
}
