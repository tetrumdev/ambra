import { useEffect, useRef, type ReactNode } from "react";
import { closeDialog, openDialog } from "../utils/dialogs";
import "./Credits.css";

export function AboutDialog({ title, subtitle, open, onClose, children }: {
  title: string;
  subtitle?: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) openDialog(dialog.current);
    else closeDialog(dialog.current);
  }, [open]);

  return <dialog ref={dialog} className="playlistEditDialog creditsDialog aboutDialog" aria-label={`About ${title}`}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <button type="button" className="playlistEditCancel" onClick={onClose}>Close</button>
    <div className="playlistEditContent">
      <div><h2>About</h2><p>{title}{subtitle ? ` · ${subtitle}` : ""}</p></div>
      <div className="creditsScroll aboutContent">{children}</div>
    </div>
  </dialog>;
}
