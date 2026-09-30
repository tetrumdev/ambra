import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./scrollbars.css";
import { hydratePersistentStorage } from "./utils/persistentStorage";
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

// The UI renders immediately from WebView storage. Reconciling with the durable
// copy happens in the background; only if that copy turns out to be newer (a
// fresh WebView profile, or another installation sharing the data directory)
// is the app remounted so it re-reads the restored state.
function Root() {
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  useEffect(() => {
    mark("first-commit");
    requestAnimationFrame(() => setTimeout(() => mark("interactive"), 0));
    void hydratePersistentStorage().then((restored) => {
      mark("state-hydrated");
      if (restored) setRestoreEpoch((epoch) => epoch + 1);
    });
  }, []);
  return <App key={restoreEpoch} />;
}

mark("first-render");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
