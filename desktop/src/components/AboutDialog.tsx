import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { closeDialog, openDialog } from "../utils/dialogs";
import "./Credits.css";

// The backdrop belongs to the dialog element, so only the click position tells it apart from the dialog's own padding.
function outside(event: MouseEvent) {
  const rect = event.currentTarget.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
}

export function AboutDialog({ title, subtitle, open, onClose, children }: {
  title: string;
  subtitle?: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Both press and release must land on the backdrop, so a text drag that ends outside doesn't close it.
  const pressedBackdrop = useRef(false);
  useEffect(() => {
    if (open) openDialog(dialog.current);
    else closeDialog(dialog.current);
  }, [open]);

  return <dialog ref={dialog} className="playlistEditDialog creditsDialog aboutDialog" aria-label={`About ${title}`}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}
    onPointerDown={event => { pressedBackdrop.current = outside(event); }}
    onClick={event => { if (pressedBackdrop.current && outside(event)) onClose(); }}>
    <button type="button" className="xContainer aboutDialogClose" aria-label="Close" onClick={onClose}>
      <img className="closeBtn" src="/x.svg" alt="" />
    </button>
    <div className="playlistEditContent">
      <div><h2>About</h2><p>{title}{subtitle ? ` · ${subtitle}` : ""}</p></div>
      <div className="creditsScroll aboutContent">{children}</div>
    </div>
  </dialog>;
}
