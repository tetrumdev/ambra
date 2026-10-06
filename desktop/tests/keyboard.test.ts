import { describe, expect, test } from "bun:test";
import { isBrowserShortcut, isUnmodifiedKey } from "../src/utils/keyboard";

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

describe("browser shortcuts", () => {
  test("reload, print, and caret browsing are caught", () => {
    expect(isBrowserShortcut(keyPress("KeyR", { metaKey: true }))).toBe(true);
    expect(isBrowserShortcut(keyPress("KeyR", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isBrowserShortcut(keyPress("KeyP", { ctrlKey: true }))).toBe(true);
    expect(isBrowserShortcut(keyPress("F5"))).toBe(true);
    expect(isBrowserShortcut(keyPress("F7"))).toBe(true);
    expect(isBrowserShortcut(keyPress("KeyH", { ctrlKey: true }))).toBe(true);
  });

  test("the app's own shortcuts and plain typing pass through", () => {
    expect(isBrowserShortcut(keyPress("KeyF", { metaKey: true }))).toBe(false);
    expect(isBrowserShortcut(keyPress("KeyR"))).toBe(false);
    expect(isBrowserShortcut(keyPress("Space"))).toBe(false);
    expect(isBrowserShortcut(keyPress("KeyH", { metaKey: true }))).toBe(false);
  });
});
