import { expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { closeDialog, openDialog } from "../src/utils/dialogs";
import { motion } from "../src/utils/motion";

test("a reopened dialog gets the full exit transition when dismissed again", () => {
  jest.useFakeTimers();
  try {
    const window = new Window();
    const element = window.document.createElement("dialog");
    window.document.body.append(element);
    const dialog = element as unknown as HTMLDialogElement;
    const halfway = motion.feedback.duration / 2;

    openDialog(dialog);
    closeDialog(dialog);
    jest.advanceTimersByTime(halfway);
    openDialog(dialog);
    closeDialog(dialog);
    jest.advanceTimersByTime(halfway);

    expect(dialog.open).toBe(true);
    expect(dialog.dataset.closing).toBe("");

    jest.advanceTimersByTime(halfway);
    expect(dialog.open).toBe(false);
    expect(dialog.dataset.closing).toBeUndefined();
  } finally {
    jest.useRealTimers();
  }
});
