import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { isUnmodifiedKey } from "../utils/keyboard";

type AudioControlsMenuProps = {
  anchor: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
  onClose: () => void;
};

export function AudioControlsMenu({
  anchor,
  children,
  onClose,
}: AudioControlsMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });

  useLayoutEffect(() => {
    const anchorElement = anchor.current;
    const panelElement = panel.current;
    if (!anchorElement || !panelElement) return;

    const reposition = () => {
      const anchorBounds = anchorElement.getBoundingClientRect();
      const menuBounds = panelElement.getBoundingClientRect();
      const left = Math.max(
        4,
        Math.min(anchorBounds.right - menuBounds.width, window.innerWidth - menuBounds.width - 4),
      );
      const top = Math.max(
        4,
        Math.min(anchorBounds.top - menuBounds.height - 10, window.innerHeight - menuBounds.height - 4),
      );
      setPosition((current) =>
        current.left === left && current.top === top && current.ready
          ? current
          : { left, top, ready: true },
      );
    };

    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(panelElement);
    window.addEventListener("resize", reposition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
    };
  }, [anchor]);

  useEffect(() => {
    panel.current
      ?.querySelector<HTMLElement>(
        "select:not(:disabled), button:not(:disabled), input:not(:disabled)",
      )
      ?.focus();
  }, []);

  return createPortal(
    <div
      className="clickMenuBackdrop"
      data-click-menu-backdrop
      onClick={onClose}
      onKeyDown={(event) => {
        if (!isUnmodifiedKey(event, "Escape")) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        ref={panel}
        className="devAudioControls"
        role="dialog"
        aria-label="Audio controls"
        style={{
          left: position.left,
          top: position.top,
          visibility: position.ready ? "visible" : "hidden",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
