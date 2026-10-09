import { useRef, useState } from "react";
import { closeDialog, openDialog } from "../utils/dialogs";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { ArtworkImage } from "./ArtworkImage";
import "./AlbumArtwork.css";
import "./AppChrome.css";

// `noun` names the image for assistive labels; artist pages reuse this for portraits.
export function AlbumArtwork({ src, title, noun = "cover" }: { src: string | null; title: string; noun?: "cover" | "portrait" }) {
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
        aria-label={`Enlarge ${title} ${noun}`}
        aria-haspopup="dialog"
        onClick={() => {
          setExpanded(false);
          setHasDragRegion(Boolean(document.querySelector(
            ".libraryTitlebar:not(.albumArtworkDragRegion)[data-tauri-drag-region], .bigscreenTitlebar[data-tauri-drag-region]",
          )));
          openDialog(dialog.current);
        }}
      >
        <ArtworkImage src={src} alt={`${title} ${noun}`} loading="eager" />
      </button>
      <dialog
        ref={dialog}
        className="albumArtworkDialog"
        aria-label={`${title} ${noun}`}
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
          aria-label={expanded ? `Return to large ${noun}` : `Expand ${noun} to window`}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          <img
            src={src || whiteArtwork}
            alt={`${title} ${noun}`}
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
