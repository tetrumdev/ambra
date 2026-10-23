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

/** Cmd/Ctrl+comma, the usual shortcut for an app's settings. */
export function isSettingsShortcut(event: KeyPress) {
  return event.code === "Comma" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

/** App history uses the same directions as browser navigation keys and mouse side buttons. */
export function navigationShortcut(event: KeyPress): "back" | "forward" | null {
  if (isUnmodifiedKey(event, "BrowserBack")) return "back";
  if (isUnmodifiedKey(event, "BrowserForward")) return "forward";
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.code === "ArrowLeft") return "back";
    if (event.code === "ArrowRight") return "forward";
  }
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (event.code === "BracketLeft") return "back";
    if (event.code === "BracketRight") return "forward";
  }
  return null;
}

/** Whether keys pressed here are being typed, so single-letter shortcuts must leave them alone. */
export function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.matches("input:not([type='range']):not([type='checkbox']):not([type='radio']), textarea, select"));
}

/** The WebView's find-in-page, which Ambra's search replaces everywhere, development included. */
export function isBrowserFindShortcut(event: KeyPress) {
  return event.code === "F3" || ((event.ctrlKey || event.metaKey) && !event.altKey && (event.code === "KeyF" || event.code === "KeyG"));
}

// Shortcuts the WebView would answer with browser behavior (reload, print,
// view source, caret browsing...). A native app has none of these.
const BROWSER_MODIFIED_KEYS = new Set(["KeyR", "KeyP", "KeyU", "KeyS", "KeyO", "KeyJ"]);
const BROWSER_FUNCTION_KEYS = new Set(["F5", "F7", "BrowserRefresh"]);

export function isBrowserShortcut(event: KeyPress) {
  if (BROWSER_FUNCTION_KEYS.has(event.code)) return true;
  // Ctrl+H is browser history on Windows/Linux; Cmd+H (hide app) never reaches the page.
  if (event.ctrlKey && !event.metaKey && event.code === "KeyH") return true;
  return (event.ctrlKey || event.metaKey) && !event.altKey && BROWSER_MODIFIED_KEYS.has(event.code);
}

/** A shortcut named by the character it types, so it follows the keyboard layout: "/" is Shift+7 on some. */
export function isCharacterKey(event: KeyboardEvent, character: string) {
  return event.key === character && !event.ctrlKey && !event.metaKey && !event.altKey;
}

// Controls that use the arrow keys themselves: sliders, menus, lists and column resizing.
const ARROW_KEY_OWNERS = "input[type='range'], [role='slider'], [role='menu'], [role='listbox'], [role='radiogroup'], [role='tablist'], select, .columnResizeHandle";

/**
 * Whether a single-key playback shortcut may act: nothing is being typed, nothing open such as a
 * menu or dialog has the keyboard, and, for arrows, the focused control has no use of its own for them.
 */
export function acceptsPlaybackShortcut(event: KeyboardEvent, arrows = false, ignoreOpenMenus = false) {
  if (event.defaultPrevented || isTypingTarget(event.target)) return false;
  if (!ignoreOpenMenus && document.querySelector("dialog[open], #trackMenuBackdrop, [data-click-menu-backdrop], .columnPickerMenu")) return false;
  return !arrows || !(event.target instanceof Element && event.target.closest(ARROW_KEY_OWNERS));
}
