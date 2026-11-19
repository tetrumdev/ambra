import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { isMac, matchesShortcut } from "../utils/shortcuts";
import { pageNeedsFocusOnActivation } from "../utils/windowChrome";

/** On Windows the style change takes keyboard focus from the page, so shortcuts like Space stop until it's clicked. */
async function setWindowFullscreen(fullscreen: boolean) {
  await getCurrentWindow().setFullscreen(fullscreen);
  await getCurrentWebview().setFocus();
}

/** How long playback may stop before the display is allowed to sleep again. */
const DISPLAY_WAKE_RELEASE_DELAY_MS = 5_000;

export function useWindowFullscreen(isPlayerView: boolean, playing: boolean) {
  const [isFullscreen, setIsFullscreen] = useState<boolean | null>(null);
  useEffect(() => {
    if (!isTauri()) {
      setIsFullscreen(false);
      return;
    }

    let disposed = false;
    let stopListening: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    let known: boolean | null = null;
    const syncFullscreen = async () => {
      try {
        const fullscreen = await appWindow.isFullscreen();
        if (disposed) return;
        setIsFullscreen(fullscreen);
        // However fullscreen changed (macOS's green button, its menu or shortcut, the window
        // manager, or ours), the window's style change can take keyboard focus from the page,
        // and every shortcut stops until it's clicked. Hand it back when the window has focus.
        if (known !== null && known !== fullscreen && await appWindow.isFocused()) {
          await getCurrentWebview().setFocus();
        }
        known = fullscreen;
      } catch (error) {
        console.error("Could not read fullscreen state:", error);
        if (!disposed) setIsFullscreen(false);
      }
    };

    void syncFullscreen();
    void appWindow.onResized(syncFullscreen).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    });
    // macOS can give the window focus back only once the fullscreen Space finishes animating,
    // without giving it to the page. The page is the window's only content, so it always takes it.
    let stopFocus: (() => void) | undefined;
    void appWindow.onFocusChanged(({ payload: focused }) => {
      if (focused && pageNeedsFocusOnActivation()) void getCurrentWebview().setFocus().catch(() => {});
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopFocus = unlisten;
    });

    return () => {
      disposed = true;
      stopListening?.();
      stopFocus?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-window-fullscreen",
      isFullscreen === true,
    );

    return () => {
      document.documentElement.removeAttribute("data-window-fullscreen");
    };
  }, [isFullscreen]);

  // Fullscreen in the player with music playing, the display stays on, like a video player's.
  // Letting go waits a moment, so the gap between songs doesn't hand the screen back.
  const keepDisplayAwake = isFullscreen === true && isPlayerView && playing;
  useEffect(() => {
    if (!isTauri()) return;
    const send = (awake: boolean) => void invoke("set_display_wake", { awake })
      .catch(error => console.warn("Could not change display sleep:", error));
    if (keepDisplayAwake) {
      send(true);
      return;
    }
    const release = setTimeout(() => send(false), DISPLAY_WAKE_RELEASE_DELAY_MS);
    return () => clearTimeout(release);
  }, [keepDisplayAwake]);
  useEffect(() => () => {
    if (isTauri()) void invoke("set_display_wake", { awake: false }).catch(() => {});
  }, []);

  useEffect(() => {
    // macOS owns its fullscreen command and the shortcut assigned to it.
    if (!isTauri() || isMac) return;
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (!matchesShortcut(event, "toggleFullscreen") || event.repeat) return;

      event.preventDefault();

      try {
        const nextFullscreen = !(await getCurrentWindow().isFullscreen());
        await setWindowFullscreen(nextFullscreen);
        setIsFullscreen(nextFullscreen);
      } catch (error) {
        console.error("Could not toggle fullscreen:", error);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return isFullscreen;
}
