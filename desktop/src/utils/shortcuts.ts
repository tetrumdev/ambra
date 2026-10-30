/**
 * Every keyboard shortcut in the app, by name: its defaults, the listener's own bindings (saved in
 * preferences), and matching a key press against them. Handlers ask `matchesShortcut(event, id)`
 * rather than testing keys themselves, so changing a binding in Settings changes it everywhere.
 */

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const isWindows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");

/** One key and its modifiers. `mod` is Cmd on macOS and Ctrl elsewhere; `ctrl` is the Mac's Control key. */
export type ShortcutBinding = { code: string; mod?: boolean; alt?: boolean; shift?: boolean; ctrl?: boolean };

export type ShortcutCategory = "Playback" | "Screens" | "Lists" | "Sidebar";

type ShortcutDefinition = {
  label: string;
  category: ShortcutCategory;
  defaults: ShortcutBinding[];
  /** Shown in Settings under the name. */
  hint?: string;
  /** Left out where the app can't act on it (fullscreen on macOS belongs to the system). */
  unavailable?: boolean;
};

const key = (code: string, modifiers: Omit<ShortcutBinding, "code"> = {}): ShortcutBinding => ({ code, ...modifiers });

export const shortcutDefinitions = {
  playPause: { label: "Play or pause", category: "Playback", defaults: [key("Space")] },
  previousTrack: { label: "Previous song", category: "Playback", defaults: [key("Comma")] },
  nextTrack: { label: "Next song", category: "Playback", defaults: [key("Period")] },
  seekBackward: { label: "Rewind 5 seconds", category: "Playback", defaults: [key("ArrowLeft")] },
  seekForward: { label: "Skip ahead 5 seconds", category: "Playback", defaults: [key("ArrowRight")] },
  volumeUp: { label: "Volume up", category: "Playback", defaults: [key("ArrowUp", { mod: true })] },
  volumeDown: { label: "Volume down", category: "Playback", defaults: [key("ArrowDown", { mod: true })] },
  toggleMute: { label: "Mute or unmute", category: "Playback", defaults: [key("KeyM")] },
  playCollection: { label: "Play playlist or library", category: "Playback", defaults: [key("KeyP")], hint: "Whatever list of songs is open" },
  shuffleCollection: { label: "Shuffle playlist or library", category: "Playback", defaults: [key("KeyS")], hint: "Whatever list of songs is open" },

  search: { label: "Search", category: "Screens", defaults: [key("KeyF", { mod: true })] },
  filterPage: { label: "Filter songs on the page", category: "Screens", defaults: [key("Slash")] },
  togglePlayer: { label: "Open or close the player", category: "Screens", defaults: [key("KeyF")] },
  toggleQueue: { label: "Open or close the queue", category: "Screens", defaults: [key("KeyQ")] },
  openSettings: { label: "Open settings", category: "Screens", defaults: [key("Comma", { mod: true })] },
  closeScreen: { label: "Close player, queue or settings", category: "Screens", defaults: [key("Escape")] },
  back: {
    label: "Back", category: "Screens",
    defaults: [key("ArrowLeft", { alt: true }), key("BrowserBack"), ...(isMac ? [key("BracketLeft", { mod: true })] : [])],
  },
  forward: {
    label: "Forward", category: "Screens",
    defaults: [key("ArrowRight", { alt: true }), key("BrowserForward"), ...(isMac ? [key("BracketRight", { mod: true })] : [])],
  },
  toggleFullscreen: { label: "Fullscreen", category: "Screens", defaults: [key("F11")], unavailable: !isWindows },

  listNext: { label: "Next item in list", category: "Lists", defaults: [key("ArrowDown")], hint: "Songs, search results, albums and cards" },
  listPrevious: { label: "Previous item in list", category: "Lists", defaults: [key("ArrowUp")] },
  listFirst: { label: "First item in list", category: "Lists", defaults: [key("Home")] },
  listLast: { label: "Last item in list", category: "Lists", defaults: [key("End")] },
  playSelected: { label: "Play selected song", category: "Lists", defaults: [key("Enter")], hint: "Opens an album, artist or card" },
  addSelectedToQueue: { label: "Add selected song to queue", category: "Lists", defaults: [key("Enter", { shift: true })] },
  playSelectedNext: { label: "Play selected song next", category: "Lists", defaults: [key("Enter", { mod: true })] },

  filterSidebar: { label: "Filter sidebar", category: "Sidebar", defaults: [key("KeyK", { mod: true })], hint: "Find a playlist or service" },
  sidebarNext: { label: "Next item in sidebar", category: "Sidebar", defaults: [key("ArrowDown", { alt: true })], hint: "Including the playlist dropdowns" },
  sidebarPrevious: { label: "Previous item in sidebar", category: "Sidebar", defaults: [key("ArrowUp", { alt: true })] },
} satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof shortcutDefinitions;
export type ShortcutOverrides = Partial<Record<ShortcutId, ShortcutBinding[]>>;

export const shortcutIds = Object.keys(shortcutDefinitions) as ShortcutId[];
export const shortcutCategories: ShortcutCategory[] = ["Playback", "Screens", "Lists", "Sidebar"];

export function shortcutDefinition(id: ShortcutId): ShortcutDefinition {
  return shortcutDefinitions[id];
}

/** Saved bindings, keeping only well-formed ones for shortcuts that still exist. */
export function readShortcutOverrides(value: unknown): ShortcutOverrides {
  if (typeof value !== "object" || value === null) return {};
  const overrides: ShortcutOverrides = {};
  for (const [id, bindings] of Object.entries(value)) {
    if (!(id in shortcutDefinitions) || !Array.isArray(bindings)) continue;
    overrides[id as ShortcutId] = bindings
      .filter((binding): binding is ShortcutBinding => typeof binding === "object" && binding !== null && typeof binding.code === "string")
      .map(({ code, mod, alt, shift, ctrl }) => ({ code, mod: mod === true || undefined, alt: alt === true || undefined, shift: shift === true || undefined, ctrl: ctrl === true || undefined }));
  }
  return overrides;
}

let overrides: ShortcutOverrides = {};
let suspended = false;

export function setShortcutOverrides(next: ShortcutOverrides) {
  overrides = next;
}

/** While Settings records a new binding, no shortcut acts on the keys pressed. */
export function suspendShortcuts(suspend: boolean) {
  suspended = suspend;
}

export function shortcutBindings(id: ShortcutId, from: ShortcutOverrides = overrides): ShortcutBinding[] {
  return from[id] ?? shortcutDefinitions[id].defaults;
}

const MODIFIER_CODES = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "OSLeft", "OSRight", "Fn", "CapsLock"]);

export function isModifierCode(code: string) {
  return MODIFIER_CODES.has(code);
}

type KeyPress = Pick<KeyboardEvent, "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">;

/** The binding a key press makes, as recorded in Settings. */
export function bindingFromEvent(event: KeyPress): ShortcutBinding {
  return {
    code: event.code,
    mod: (isMac ? event.metaKey : event.ctrlKey) || undefined,
    alt: event.altKey || undefined,
    shift: event.shiftKey || undefined,
    ctrl: (isMac && event.ctrlKey) || undefined,
  };
}

export function sameBinding(a: ShortcutBinding, b: ShortcutBinding) {
  return a.code === b.code && !a.mod === !b.mod && !a.alt === !b.alt && !a.shift === !b.shift && !a.ctrl === !b.ctrl;
}

function matchesBinding(event: KeyPress, binding: ShortcutBinding) {
  // Windows and Linux keep the Windows key out of shortcuts altogether.
  if (!isMac && event.metaKey) return false;
  return sameBinding(bindingFromEvent(event), binding);
}

export function matchesShortcut(event: KeyPress, id: ShortcutId) {
  if (suspended) return false;
  return shortcutBindings(id).some(binding => matchesBinding(event, binding));
}

/** The first of several shortcuts this key press is bound to. */
export function matchingShortcut<Id extends ShortcutId>(event: KeyPress, ids: readonly Id[]): Id | null {
  return ids.find(id => matchesShortcut(event, id)) ?? null;
}

/** Other shortcuts that already use a binding. */
export function shortcutsUsing(binding: ShortcutBinding, from: ShortcutOverrides, except?: ShortcutId) {
  return shortcutIds.filter(id => id !== except && !shortcutDefinition(id).unavailable
    && shortcutBindings(id, from).some(existing => sameBinding(existing, binding)));
}

const KEY_NAMES: Record<string, string> = {
  Space: "Space", Enter: "Enter", Escape: "Esc", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Home: "Home", End: "End", PageUp: "Page Up", PageDown: "Page Down",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
  Minus: "-", Equal: "=", Backquote: "`", BrowserBack: "Browser Back", BrowserForward: "Browser Forward",
  MediaPlayPause: "Play/Pause", MediaTrackNext: "Next Track", MediaTrackPrevious: "Previous Track",
};

// The keyboard layout's own names for keys, so a binding reads as the key it is on this keyboard.
let layout: Map<string, string> | null = null;
type LayoutKeyboard = { getLayoutMap?: () => Promise<Map<string, string>> };
const keyboard = typeof navigator !== "undefined" ? (navigator as Navigator & { keyboard?: LayoutKeyboard }).keyboard : undefined;
void keyboard?.getLayoutMap?.().then(map => { layout = map; }).catch(() => {});

export function keyName(code: string) {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  const typed = layout?.get(code);
  if (typed && typed.trim()) return typed.toUpperCase();
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

/** The keys of a binding, in the order the platform writes them. */
export function bindingKeys(binding: ShortcutBinding): string[] {
  const keys = isMac
    ? [binding.ctrl && "⌃", binding.alt && "⌥", binding.shift && "⇧", binding.mod && "⌘"]
    : [binding.mod && "Ctrl", binding.alt && "Alt", binding.shift && "Shift"];
  return [...keys.filter((part): part is string => Boolean(part)), keyName(binding.code)];
}

export function formatBinding(binding: ShortcutBinding) {
  return bindingKeys(binding).join(isMac ? "" : "+");
}

/** The shortcut's first binding, for tooltips and feedback. */
export function shortcutLabel(id: ShortcutId) {
  const binding = shortcutBindings(id)[0];
  return binding ? formatBinding(binding) : null;
}

export type ShortcutFeedback = { id: ShortcutId; text?: string };

/** A shortcut acted: the brief notice at the bottom of the window says what it did (ShortcutToast). */
export function announceShortcut(id: ShortcutId, text?: string) {
  window.dispatchEvent(new CustomEvent<ShortcutFeedback>("ambra:shortcut", { detail: { id, text } }));
}
