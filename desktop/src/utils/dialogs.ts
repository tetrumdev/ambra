import { reducedMotion } from "./reducedMotion";
import { motion } from "./motion";

const pendingClose = new WeakMap<HTMLDialogElement, ReturnType<typeof setTimeout>>();

// Dialogs fade like system sheets. The close waits for the fade (the dialog
// leaves the top layer the moment it closes), and reopening cancels a pending close.
export function openDialog(dialog: HTMLDialogElement | null) {
  if (!dialog) return;
  clearTimeout(pendingClose.get(dialog));
  pendingClose.delete(dialog);
  delete dialog.dataset.closing;
  if (!dialog.open) dialog.showModal();
}

export function closeDialog(dialog: HTMLDialogElement | null) {
  if (!dialog?.open || "closing" in dialog.dataset) return;
  if (reducedMotion()) {
    dialog.close();
    return;
  }
  dialog.dataset.closing = "";
  pendingClose.set(dialog, setTimeout(() => {
    pendingClose.delete(dialog);
    delete dialog.dataset.closing;
    dialog.close();
  }, motion.feedback.duration));
}
