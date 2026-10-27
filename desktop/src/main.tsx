import React from "react";
import ReactDOM from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Root } from "./Root";
import "./interaction.css";
import "./scrollbars.css";
import { installTooltips } from "./utils/tooltips";
import { isBrowserFindShortcut, isBrowserShortcut } from "./utils/keyboard";
import { mark, perfEnabled, setProcessOffset, startPerfTracing } from "./utils/perf";

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
