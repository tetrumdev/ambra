import { useRef, useState } from "react";
import { preloadArtwork } from "../utils/artworkImages";
import { closeDialog, openDialog } from "../utils/dialogs";
import { whiteArtwork } from "../utils/artworkPlaceholder";
import { ArtworkImage } from "./ArtworkImage";
import "./AlbumArtwork.css";
import "./AppChrome.css";

// `noun` names the image for assistive labels; artist pages reuse this for portraits.
// `resolveFull` finds the full-resolution image; the enlarged view shows `src` until it has loaded.
export function AlbumArtwork({ src, title, noun = "cover", resolveFull }: {
  src: string | null;
  title: string;
  noun?: "cover" | "portrait";
  resolveFull?: () => Promise<string | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState<{ for: string | null; url: string } | null>(null);
  const requested = useRef<string | null | undefined>(undefined);
  const loadFull = () => {
    if (!resolveFull || requested.current === src) return;
    requested.current = src;
    void resolveFull()
      .then(async (url) => {
        if (!url) {
          if (requested.current === src) requested.current = undefined;
          return;
        }
        if (url === src) return;
        await preloadArtwork(url, true);
        setFull({ for: src, url });
      })
      .catch(() => {
        if (requested.current === src) requested.current = undefined;
      });
  };
  const enlarged = full?.for === src ? full.url : src;
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
          loadFull();
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
            src={enlarged || whiteArtwork}
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
