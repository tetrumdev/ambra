const FADE_MS = 150;

// Dialogs fade like system sheets. The close waits for the fade (the dialog
// leaves the top layer the moment it closes), and reopening cancels a pending close.
export function openDialog(dialog: HTMLDialogElement | null) {
  if (!dialog) return;
  delete dialog.dataset.closing;
  if (!dialog.open) dialog.showModal();
}

export function closeDialog(dialog: HTMLDialogElement | null) {
  if (!dialog?.open || "closing" in dialog.dataset) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    dialog.close();
    return;
  }
  dialog.dataset.closing = "";
  setTimeout(() => {
    if (!("closing" in dialog.dataset)) return;
    delete dialog.dataset.closing;
    dialog.close();
  }, FADE_MS);
}
