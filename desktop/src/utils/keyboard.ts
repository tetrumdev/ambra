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

// Key presses stopped only to keep the WebView's own behavior away; Ambra's shortcuts still answer them.
const browserBlocked = new WeakSet<Event>();

/** Stops the WebView acting on a key press without hiding it from Ambra's own shortcuts. */
export function blockBrowserDefault(event: KeyboardEvent) {
  event.preventDefault();
  browserBlocked.add(event);
}

/** Whether something in the app already handled this key press. */
export function wasKeyHandled(event: KeyboardEvent) {
  return event.defaultPrevented && !browserBlocked.has(event);
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

// Controls that use the arrow keys themselves: sliders, menus, lists and column resizing.
const ARROW_KEY_OWNERS = "input[type='range'], [role='slider'], [role='menu'], [role='listbox'], [role='radiogroup'], [role='tablist'], select, .columnResizeHandle";

/**
 * Whether a single-key playback shortcut may act: nothing is being typed, nothing open such as a
 * menu or dialog has the keyboard, and, for arrows, the focused control has no use of its own for them.
 */
export function acceptsPlaybackShortcut(event: KeyboardEvent, arrows = false, ignoreOpenMenus = false) {
  if (wasKeyHandled(event) || isTypingTarget(event.target)) return false;
  if (!ignoreOpenMenus && document.querySelector("dialog[open], #trackMenuBackdrop, [data-click-menu-backdrop], .columnPickerMenu")) return false;
  return !arrows || !(event.target instanceof Element && event.target.closest(ARROW_KEY_OWNERS));
}
