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
