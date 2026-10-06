import { useRef, useState } from "react";
import { closeDialog, openDialog } from "../utils/dialogs";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { ArtworkImage } from "./ArtworkImage";
import "./AlbumArtwork.css";
import "./AppChrome.css";

export function AlbumArtwork({ src, title }: { src: string | null; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasDragRegion, setHasDragRegion] = useState(false);

  function returnOrClose() {
    if (expanded) setExpanded(false);
    else closeDialog(dialog.current);
  }

  return (
    <>
      <button
        type="button"
        className="albumArtworkTrigger"
        aria-label={`Enlarge ${title} cover`}
        aria-haspopup="dialog"
        onClick={() => {
          setExpanded(false);
          setHasDragRegion(Boolean(document.querySelector(
            ".libraryTitlebar:not(.albumArtworkDragRegion)[data-tauri-drag-region], .bigscreenTitlebar[data-tauri-drag-region]",
          )));
          openDialog(dialog.current);
        }}
      >
        <ArtworkImage src={src} alt={`${title} cover`} loading="eager" />
      </button>
      <dialog
        ref={dialog}
        className="albumArtworkDialog"
        aria-label={`${title} cover`}
        data-expanded={expanded ? "true" : undefined}
        onClick={returnOrClose}
        onCancel={(event) => {
          event.preventDefault();
          returnOrClose();
        }}
        onClose={() => setExpanded(false)}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {hasDragRegion && (
          <div className="libraryTitlebar albumArtworkDragRegion" data-tauri-drag-region aria-hidden="true" />
        )}
        <button
          type="button"
          className="albumArtworkZoom"
          aria-label={expanded ? "Return to large cover" : "Expand cover to window"}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          <img
            src={src || whiteArtwork}
            alt={`${title} cover`}
            decoding="async"
            draggable={false}
            onError={(event) => {
              if (event.currentTarget.src !== whiteArtwork) {
                event.currentTarget.src = whiteArtwork;
              }
            }}
          />
        </button>
      </dialog>
    </>
  );
}
