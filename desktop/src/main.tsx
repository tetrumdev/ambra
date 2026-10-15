import React, { useEffect, useState, useSyncExternalStore } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AudioSettingsProvider } from "./hooks/AudioSettingsContext";
import "./interaction.css";
import "./scrollbars.css";
import { hydratePersistentStorage } from "./utils/persistentStorage";
import { installTooltips } from "./utils/tooltips";
import { isBrowserShortcut } from "./utils/keyboard";
import { mark, perfEnabled, setProcessOffset, startPerfTracing } from "./utils/perf";
import { useStartupWindow } from "./hooks/useStartupWindow";
import { flushServerState, hydrateServerState, installServerStateLifecycle, reloadServerState, serverStateStatus, subscribeServerState } from "./utils/serverState";

mark("js-start");
startPerfTracing();
if (perfEnabled()) {
  // Anchor page-relative marks to the Rust process start for real startup numbers.
  void import("@tauri-apps/api/core").then(({ invoke, isTauri }) =>
    isTauri()
      ? invoke<number>("startup_elapsed_ms").then(setProcessOffset)
      : undefined,
  ).catch(() => {});
}

document.documentElement.dataset.platform = navigator.userAgent.includes(
  "Windows",
)
  ? "windows"
  : "other";

// Restore durable state before mounting so startup never renders an older session.
function Root() {
  const state = useSyncExternalStore(subscribeServerState, serverStateStatus);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  useStartupWindow(!state.ready);

  async function restore() {
    setLoading(true);
    setStartupError(null);
    try {
      await hydratePersistentStorage();
      await hydrateServerState();
      mark("state-hydrated");
    } catch (error) { setStartupError(String(error)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void restore(); }, []);
  useEffect(installServerStateLifecycle, []);
  useEffect(() => {
    mark("first-commit");
    requestAnimationFrame(() => setTimeout(() => mark("interactive"), 0));
  }, []);
  if (!state.ready) return <main className="stateStartup" aria-busy={loading}>
    <div data-tauri-drag-region className="stateTitlebar" />
    <h1>{loading ? "Loading your listening state…" : "Could not load your listening state"}</h1>
    {startupError && <>
      <p role="alert">{startupError}</p>
      <p>Start the Ambra server, then retry. Existing data stays untouched.</p>
    </>}
    <button disabled={loading} onClick={() => void restore()}>Retry</button>
  </main>;

  return <>
    <AudioSettingsProvider><App /></AudioSettingsProvider>
    {state.error && <div className="stateSaveError" role="alert">
      <span>{state.error}{state.conflict && " Reloading discards unsaved changes in this window."}</span>
      {state.conflict
        ? <button onClick={reloadServerState}>Reload server state</button>
        : <button onClick={() => void flushServerState().catch(() => {})}>Retry save</button>}
    </div>}
  </>;
}

installTooltips();
// Development keeps reload and friends.
if (!import.meta.env.DEV) {
  window.addEventListener("keydown", (event) => {
    if (isBrowserShortcut(event)) event.preventDefault();
  }, true);
}

mark("first-render");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
