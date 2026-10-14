import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AudioSettingsProvider } from "./hooks/AudioSettingsContext";
import "./interaction.css";
import "./scrollbars.css";
import { hydratePersistentStorage } from "./utils/persistentStorage";
import { installTooltips } from "./utils/tooltips";
import { isBrowserShortcut } from "./utils/keyboard";
import { mark, perfEnabled, setProcessOffset, startPerfTracing } from "./utils/perf";

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
  useEffect(() => {
    mark("first-commit");
    requestAnimationFrame(() => setTimeout(() => mark("interactive"), 0));
  }, []);
  return <AudioSettingsProvider><App /></AudioSettingsProvider>;
}

installTooltips();
// Development keeps reload and friends.
if (!import.meta.env.DEV) {
  window.addEventListener("keydown", (event) => {
    if (isBrowserShortcut(event)) event.preventDefault();
  }, true);
}

void hydratePersistentStorage().then(() => {
  mark("state-hydrated");
  mark("first-render");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
});
