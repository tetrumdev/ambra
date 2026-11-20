import { useContext, useEffect, useRef, type KeyboardEventHandler, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { SongContextMenu } from "../utils/trackMenu";

export function TrackMenuBackdrop({ children, song, onClose, onKeyDown }: {
  children: ReactNode;
  song: boolean;
  onClose: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) {
  const combinedMenu = useContext(SongContextMenu);
  const allowRightClick = song && combinedMenu;
  const backdrop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!allowRightClick) return;

    function handleOutside(event: MouseEvent) {
      if (!backdrop.current || event.composedPath().includes(backdrop.current)) return;
      if (event.type === "contextmenu") {
        // Unmount the old menu before the clicked song opens a fresh one.
        flushSync(onClose);
        return;
      }
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "click") onClose();
    }

    document.addEventListener("pointerdown", handleOutside, true);
    document.addEventListener("click", handleOutside, true);
    document.addEventListener("contextmenu", handleOutside, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutside, true);
      document.removeEventListener("click", handleOutside, true);
      document.removeEventListener("contextmenu", handleOutside, true);
    };
  }, [allowRightClick, onClose]);

  return <div ref={backdrop} id="trackMenuBackdrop" data-song-context-menu={allowRightClick || undefined}
    onClick={onClose} onKeyDown={onKeyDown}>{children}</div>;
}
