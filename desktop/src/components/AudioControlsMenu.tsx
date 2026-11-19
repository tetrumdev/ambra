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
import { useFadeOutOnUnmount } from "../hooks/useFadeOutOnUnmount";

type AudioControlsMenuProps = {
  anchor: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
  onClose: () => void;
  label?: string;
  /** Which edge of the anchor the panel lines up with. */
  align?: "right" | "center";
  className?: string;
};

export function AudioControlsMenu({
  anchor,
  children,
  onClose,
  label = "Audio controls",
  align = "right",
  className,
}: AudioControlsMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  useFadeOutOnUnmount(panel);
  const [position, setPosition] = useState<{ left: number; bottom: number; maxHeight: number }>();

  useLayoutEffect(() => {
    const anchorElement = anchor.current;
    const panelElement = panel.current;
    if (!anchorElement || !panelElement) return;

    const reposition = () => {
      const anchorBounds = anchorElement.getBoundingClientRect();
      const width = panelElement.offsetWidth;
      const left = Math.max(
        4,
        Math.min(
          align === "center"
            ? anchorBounds.left + anchorBounds.width / 2 - width / 2
            : anchorBounds.right - width,
          window.innerWidth - width - 4,
        ),
      );
      // Keep the bottom edge anchored while the contents resize or animate.
      const bottom = Math.max(4, window.innerHeight - anchorBounds.top + 10);
      const maxHeight = Math.max(0, window.innerHeight - bottom - 4);
      setPosition((current) =>
        current?.left === left && current.bottom === bottom && current.maxHeight === maxHeight
          ? current
          : { left, bottom, maxHeight },
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
  }, [anchor, align]);

  useEffect(() => {
    // With nothing to operate, the panel itself takes focus so Escape still closes it.
    (panel.current
      ?.querySelector<HTMLElement>(
        '[role="radio"][aria-checked="true"]:not(:disabled), button:not(:disabled), input:not(:disabled)',
      ) ?? panel.current)
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
        className={className ? `devAudioControls ${className}` : "devAudioControls"}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        style={{
          ...position,
          transformOrigin: align === "center" ? "center bottom" : "right bottom",
          visibility: position ? "visible" : "hidden",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
