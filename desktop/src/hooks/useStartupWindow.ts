import { useEffect, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Reveal the native window after restored UI and fonts are committed. */
export function useStartupWindow(ready: boolean) {
  const shown = useRef(false);

  useEffect(() => {
    if (!ready || shown.current || !isTauri()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    void document.fonts.ready.then(() => {
      if (cancelled) return;
      // Yield after React's startup effects. Hidden WebViews can suspend animation
      // frames, so revealing the window must not depend on requestAnimationFrame.
      timer = setTimeout(() => {
        if (cancelled) return;
        shown.current = true;
        const appWindow = getCurrentWindow();
        void appWindow.show().then(() => {
          if (!cancelled) {
            void appWindow.setFocus().catch((error) => {
              console.error("Could not focus the main window:", error);
            });
          }
        }).catch((error) => {
          shown.current = false;
          console.error("Could not show the main window:", error);
        });
      }, 0);
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ready]);
}
