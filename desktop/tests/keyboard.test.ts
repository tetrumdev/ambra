import { describe, expect, test } from "bun:test";
import { isUnmodifiedKey } from "../src/utils/keyboard";

const keyPress = (
  code: string,
  modifiers: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {},
) => ({
  code,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("in-app keyboard shortcuts", () => {
  test("accept the shortcut key by itself", () => {
    expect(isUnmodifiedKey(keyPress("KeyF"), "KeyF")).toBe(true);
    expect(isUnmodifiedKey(keyPress("Space"), "Space")).toBe(true);
    expect(isUnmodifiedKey(keyPress("Escape"), "Escape")).toBe(true);
    expect(isUnmodifiedKey(keyPress("F11"), "F11")).toBe(true);
  });

  test("yield every modified shortcut to the system", () => {
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect(isUnmodifiedKey(keyPress("KeyF", { [modifier]: true }), "KeyF")).toBe(false);
      expect(isUnmodifiedKey(keyPress("Space", { [modifier]: true }), "Space")).toBe(false);
      expect(isUnmodifiedKey(keyPress("Escape", { [modifier]: true }), "Escape")).toBe(false);
      expect(isUnmodifiedKey(keyPress("F11", { [modifier]: true }), "F11")).toBe(false);
    }
  });

  test("honor modifier state reported separately by the WebView", () => {
    for (const modifier of ["Fn", "Meta"] as const) {
      expect(isUnmodifiedKey({
        ...keyPress("KeyF"),
        getModifierState: (key) => key === modifier,
      }, "KeyF")).toBe(false);
    }
  });
});
