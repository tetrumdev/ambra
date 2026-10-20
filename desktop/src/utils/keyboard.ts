type ShortcutModifier = "Alt" | "Control" | "Fn" | "Meta" | "Shift";

type KeyPress = {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  getModifierState?: (key: ShortcutModifier) => boolean;
};

export function isUnmodifiedKey(event: KeyPress, code: string) {
  const modifierIsActive = (key: ShortcutModifier) => event.getModifierState?.(key) === true;
  return event.code === code
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && !modifierIsActive("Alt")
    && !modifierIsActive("Control")
    && !modifierIsActive("Fn")
    && !modifierIsActive("Meta")
    && !modifierIsActive("Shift");
}

/** Cmd/Ctrl+F, which opens Ambra's search instead of the WebView's find bar. */
export function isSearchShortcut(event: KeyPress) {
  return event.code === "KeyF" && (event.ctrlKey || event.metaKey) && !event.altKey;
}

/** The WebView's find-in-page, which Ambra's search replaces everywhere, development included. */
export function isBrowserFindShortcut(event: KeyPress) {
  return event.code === "F3" || ((event.ctrlKey || event.metaKey) && !event.altKey && (event.code === "KeyF" || event.code === "KeyG"));
}

// Shortcuts the WebView would answer with browser behavior (reload, print,
// view source, caret browsing...). A native app has none of these.
const BROWSER_MODIFIED_KEYS = new Set(["KeyR", "KeyP", "KeyU", "KeyS", "KeyO", "KeyJ"]);
const BROWSER_FUNCTION_KEYS = new Set(["F5", "F7", "BrowserBack", "BrowserForward", "BrowserRefresh"]);

export function isBrowserShortcut(event: KeyPress) {
  if (BROWSER_FUNCTION_KEYS.has(event.code)) return true;
  // Ctrl+H is browser history on Windows/Linux; Cmd+H (hide app) never reaches the page.
  if (event.ctrlKey && !event.metaKey && event.code === "KeyH") return true;
  return (event.ctrlKey || event.metaKey) && !event.altKey && BROWSER_MODIFIED_KEYS.has(event.code);
}
