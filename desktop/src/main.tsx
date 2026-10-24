import React, { useEffect, useState, useSyncExternalStore } from "react";
import ReactDOM from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import App from "./App";
import { AudioSettingsProvider } from "./hooks/AudioSettingsContext";
import "./interaction.css";
import "./scrollbars.css";
import { hydratePersistentStorage } from "./utils/persistentStorage";
import { installTooltips } from "./utils/tooltips";
import { isBrowserFindShortcut, isBrowserShortcut } from "./utils/keyboard";
import { mark, perfEnabled, setProcessOffset, startPerfTracing } from "./utils/perf";
import { useStartupWindow } from "./hooks/useStartupWindow";
import { flushServerState, hydrateServerState, installServerStateLifecycle, reloadServerState, serverStateStatus, subscribeServerState } from "./utils/serverState";
import { connectToServer } from "./api/serverConnection";
import { ServerOffer, ServerSetup } from "./components/settings/ServerSettings";

mark("js-start");
startPerfTracing();
if (perfEnabled()) {
  // Anchor page-relative marks to the Rust process start for real startup numbers.
  if (isTauri()) {
    void invoke<number>("startup_elapsed_ms").then(setProcessOffset).catch(() => {});
  }
}

document.documentElement.dataset.platform = navigator.userAgent.includes(
  "Windows",
)
  ? "windows"
  : "other";

// Connect to the selected server; discovery and pairing work before it is connected.
function Root() {
  // Only the fields shown here, so routine saves don't rerender the whole app.
  const state = {
    ready: useSyncExternalStore(subscribeServerState, () => serverStateStatus().ready),
    error: useSyncExternalStore(subscribeServerState, () => serverStateStatus().error),
    conflict: useSyncExternalStore(subscribeServerState, () => serverStateStatus().conflict),
  };
  const [loading, setLoading] = useState(true);
  const [started, setStarted] = useState(false);
  useStartupWindow(!state.ready);

  async function restore() {
    setLoading(true);
    try {
      await connectToServer();
      await hydratePersistentStorage();
      await hydrateServerState();
      mark("state-hydrated");
    } catch { /* Keep the connection screen available while the selected server is away. */ }
    finally { setLoading(false); setStarted(true); }
  }

  useEffect(() => { void restore(); }, []);
  useEffect(() => {
    if (state.ready || loading || !started) return;
    const retry = setTimeout(() => void restore(), 5000);
    return () => clearTimeout(retry);
  }, [state.ready, loading, started]);
  useEffect(installServerStateLifecycle, []);
  useEffect(() => {
    mark("first-commit");
    requestAnimationFrame(() => setTimeout(() => mark("interactive"), 0));
  }, []);
  if (!state.ready && !started) return <main className="stateStartup" aria-busy={loading}>
    <div data-tauri-drag-region className="stateTitlebar" />
    <h1>Loading your listening state…</h1>
  </main>;

  if (!state.ready) return <main className="stateStartup">
    <div data-tauri-drag-region className="stateTitlebar" />
    <ServerSetup loading={loading} onReconnect={() => void restore()} />
  </main>;

  const statusMessage = `${state.error ?? ""}${state.conflict ? " Reloading discards unsaved changes in this window." : ""}`;

  return <>
    <div className="appViewport">
      <AudioSettingsProvider><App localOnly={false} /></AudioSettingsProvider>
    </div>
    <ServerOffer />
    {state.error && <div className="stateSaveError" role="alert">
      <span title={statusMessage}>{statusMessage}</span>
      {state.conflict
        ? <button onClick={reloadServerState}>Reload server state</button>
        : <button onClick={() => void flushServerState().catch(() => {})}>Retry save</button>}
    </div>}
  </>;
}

installTooltips();
window.addEventListener("keydown", (event) => {
  if (isBrowserFindShortcut(event)) event.preventDefault();
}, true);
// Development blocks them too; code changes still reload through Vite.
window.addEventListener("keydown", (event) => {
  if (isBrowserShortcut(event)) event.preventDefault();
}, true);

mark("first-render");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
