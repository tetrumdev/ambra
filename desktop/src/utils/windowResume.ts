import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { pageNeedsFocusOnActivation } from "./windowChrome";

/** Resume from both browser visibility and the native window's activation. */
export function onWindowResume(refresh: () => void) {
  let disposed = false;
  let stopNative: (() => void) | undefined;
  const visible = () => { if (!document.hidden) refresh(); };
  window.addEventListener("focus", refresh);
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", visible);
  if (isTauri()) {
    void listen("tauri://focus", () => {
      if (disposed) return;
      // Activating the GTK window does not necessarily focus its WebKit view.
      // Restore that view's activity as we read and paint fresh state. Recovery
      // must not wait for a focus IPC reply that may itself have been suspended.
      if (pageNeedsFocusOnActivation()) {
        try {
          void getCurrentWebview().setFocus().catch(error => {
            console.warn("Could not restore playback view focus:", error);
          });
        } catch (error) {
          console.warn("Could not restore playback view focus:", error);
        }
      }
      if (!disposed) refresh();
    }, { target: { kind: "Window", label: "main" } }).then(stop => {
      if (disposed) stop();
      else stopNative = stop;
    }).catch(error => console.warn("Could not follow native window activation:", error));
  }
  return () => {
    disposed = true;
    stopNative?.();
    window.removeEventListener("focus", refresh);
    window.removeEventListener("pageshow", refresh);
    document.removeEventListener("visibilitychange", visible);
  };
}
