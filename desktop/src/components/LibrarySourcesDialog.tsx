import { invoke, isTauri } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import {
  completeServiceAuth,
  serviceAuthStatus,
  startServiceAuth,
  type ServiceAuthStatus,
  type StreamingProvider,
} from "../api/server";

type CallbackProvider = Exclude<StreamingProvider, "spotify">;

type Props = {
  onRescanLocalMusic: () => Promise<number>;
  onServiceConnected: () => void;
};

const services: Array<{ id: StreamingProvider; name: string; detail: string }> = [
  { id: "tidal", name: "Tidal", detail: "Lossless and hi-res streaming" },
  { id: "qobuz", name: "Qobuz", detail: "Lossless and hi-res streaming" },
  { id: "spotify", name: "Spotify", detail: "Connect with Spotify in your browser" },
];

const disconnected: ServiceAuthStatus = {
  tidal: false,
  qobuz: false,
  spotify: false,
};

export function LibrarySourcesDialog({ onRescanLocalMusic, onServiceConnected }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ServiceAuthStatus>(disconnected);
  const [busy, setBusy] = useState<StreamingProvider | "local" | null>(null);
  const [callbackProvider, setCallbackProvider] = useState<CallbackProvider | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void serviceAuthStatus()
      .then(setStatus)
      .catch((reason: unknown) => setError(String(reason)));
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

  async function signIn(provider: StreamingProvider) {
    setBusy(provider);
    setError(null);
    setMessage(null);
    try {
      const result = await startServiceAuth(provider);
      if (result.status === "connected") {
        setStatus((current) => ({ ...current, [provider]: true }));
        setMessage(`${services.find((service) => service.id === provider)?.name} connected.`);
        onServiceConnected();
      } else if (result.loginUrl && provider !== "spotify") {
        setCallbackProvider(provider);
        setCallbackUrl("");
        await openUrl(result.loginUrl);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function finishSignIn() {
    if (!callbackProvider || !callbackUrl.trim()) return;
    const provider = callbackProvider;
    setBusy(provider);
    setError(null);
    try {
      await completeServiceAuth(provider, callbackUrl.trim());
      setStatus((current) => ({ ...current, [provider]: true }));
      setCallbackProvider(null);
      setCallbackUrl("");
      setMessage(`${services.find((service) => service.id === provider)?.name} connected.`);
      onServiceConnected();
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
        aria-label="Add music and connect services"
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
              <p>Import local music or connect a streaming service.</p>
            </div>
            <button type="button" className="librarySourcesClose" aria-label="Close" onClick={close}>×</button>
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

          {services.map((service) => (
            <section className="librarySourceRow" key={service.id}>
              <div>
                <h3>{service.name}</h3>
                <p>{service.detail}</p>
              </div>
              <button
                type="button"
                className="libraryServiceButton"
                disabled={status[service.id] || busy !== null}
                onClick={() => void signIn(service.id)}
              >
                {status[service.id]
                  ? "Connected"
                  : busy === service.id
                    ? service.id === "spotify" ? "Waiting…" : "Opening…"
                    : "Sign in"}
              </button>
            </section>
          ))}

          {callbackProvider && (
            <form
              className="libraryCallbackForm"
              onSubmit={(event) => {
                event.preventDefault();
                void finishSignIn();
              }}
            >
              <label htmlFor="library-callback-url">
                Paste the full {callbackProvider === "tidal" ? "Tidal" : "Qobuz"} callback URL
              </label>
              <p>The page may fail to load after sign-in. Copy its full address from the browser.</p>
              <div>
                <input
                  id="library-callback-url"
                  autoFocus
                  value={callbackUrl}
                  onChange={(event) => setCallbackUrl(event.target.value)}
                  placeholder="http://…"
                />
                <button type="submit" disabled={!callbackUrl.trim() || busy !== null}>Connect</button>
              </div>
            </form>
          )}

          {message && <p className="librarySourcesMessage" role="status">{message}</p>}
          {error && <p className="librarySourcesError" role="alert">{error}</p>}
        </div>
      </dialog>
    </>
  );
}
