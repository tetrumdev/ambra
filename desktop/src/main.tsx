// Must stay first: see utils/abortSignalAny.ts.
import "./utils/installAbortSignalAny";
import "./design-system/tokens.css";
import "./design-system/fonts.css";
import "./design-system/serif.css";
import "./design-system/base-controls.css";
import "./design-system/controls.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Root } from "./Root";
import "./interaction.css";
import "./scrollbars.css";
import { installTooltips } from "./utils/tooltips";
import { blockBrowserDefault, isBrowserFindShortcut, isBrowserShortcut, moveBetweenFields } from "./utils/keyboard";
import { mark, perfEnabled, setProcessOffset, startPerfTracing } from "./utils/perf";
import { desktopPlatform, installWindowDragRegions } from "./utils/windowChrome";
import { startDownloads } from "./utils/offlineDownloads";
import { detectGraphicsTier, followWindowFocus } from "./utils/graphicsTier";
import "./lowGraphics.css";

mark("js-start");
startPerfTracing();
if (perfEnabled()) {
  // Anchor page-relative marks to the Rust process start for real startup numbers.
  if (isTauri()) {
    void invoke<number>("startup_elapsed_ms").then(setProcessOffset).catch(() => {});
  }
}

document.documentElement.dataset.platform = desktopPlatform();
installWindowDragRegions();

installTooltips();
startDownloads();
detectGraphicsTier();
followWindowFocus();
window.addEventListener("keydown", (event) => {
  if (isBrowserFindShortcut(event)) blockBrowserDefault(event);
}, true);
window.addEventListener("keydown", moveBetweenFields, true);
// Development blocks them too; code changes still reload through Vite.
window.addEventListener("keydown", (event) => {
  if (isBrowserShortcut(event)) blockBrowserDefault(event);
}, true);

mark("first-render");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
