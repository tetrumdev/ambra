import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useTrackColumns } from "../hooks/useTrackColumns";
import { nextTrackSort, type TrackSort } from "../utils/trackCollectionOrder";
import { isOptionalColumn, optionalTrackColumns, resizeColumnPair, trackColumns, type ColumnKey, type ColumnWidths } from "../utils/trackColumnWidths";
import { isUnmodifiedKey } from "../utils/keyboard";
import "./TrackColumnHeader.css";

type Props = {
  headerRef: RefObject<HTMLDivElement | null>;
  sort?: TrackSort;
  onSortChange?: (sort: TrackSort) => void;
};

// Header and rows share their parent's grid variable. Updating it avoids
// rerendering track rows during a drag, including virtualized collections.
export function TrackColumnHeader({ headerRef, sort = null, onSortChange }: Props) {
  const preferred = useRef<ColumnWidths | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const { extra } = useTrackColumns();
  const shownColumns = trackColumns.filter(column => !isOptionalColumn(column.key) || extra.includes(column.key));

  // Columns added or removed invalidate widths dragged for the old set.
  const columnSet = extra.join(",");
  useLayoutEffect(() => {
    preferred.current = null;
    headerRef.current?.parentElement?.style.removeProperty("--resized-library-columns");
  }, [columnSet, headerRef]);

  function visibleColumns() {
    const header = headerRef.current;
    return header ? shownColumns.filter(column => {
      const cell = header.querySelector<HTMLElement>(`.${column.className}`);
      return cell && getComputedStyle(cell).display !== "none";
    }) : [];
  }

  function measuredWidths(): ColumnWidths {
    const header = headerRef.current;
    if (!header) return {};
    return Object.fromEntries(visibleColumns().map(column => [
      column.key, header.querySelector<HTMLElement>(`.${column.className}`)!.getBoundingClientRect().width,
    ]));
  }

  function apply(widths: ColumnWidths) {
    const header = headerRef.current;
    const owner = header?.parentElement;
    if (!header || !owner) return;
    const visible = visibleColumns();
    const leading = getComputedStyle(header).getPropertyValue("--library-leading-width").trim() || "100px";
    const template = [leading, ...visible.map(column => column.key === "duration"
      ? `${Math.max(64, Math.min(180, widths.duration ?? 64))}px`
      : `minmax(${visible.length === 2 ? 0 : column.min}px, ${widths[column.key] ?? column.min}fr)`), "40px"].join(" ");
    owner.style.setProperty("--resized-library-columns", template);
  }

  function remember(widths: ColumnWidths) {
    preferred.current = { ...preferred.current, ...widths };
    apply(widths);
  }

  useLayoutEffect(() => {
    const header = headerRef.current;
    const owner = header?.parentElement;
    if (!header || !owner) return;
    const observer = new ResizeObserver(() => {
      // Visible columns can change at the queue's compact breakpoint.
      if (preferred.current) apply(preferred.current);
    });
    observer.observe(header);
    return () => {
      cleanup.current?.();
      observer.disconnect();
      owner.style.removeProperty("--resized-library-columns");
    };
  }, [headerRef]);

  function neighbor(key: ColumnKey) {
    const visible = visibleColumns();
    return visible[visible.findIndex(column => column.key === key) + 1]?.key;
  }

  function startResize(event: PointerEvent<HTMLButtonElement>, key: ColumnKey) {
    if (event.button !== 0) return;
    const right = neighbor(key);
    if (!right) return;
    event.preventDefault();
    event.stopPropagation();
    cleanup.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const widths = measuredWidths();
    const previousPreference = preferred.current;
    const owner = headerRef.current!.parentElement!;
    const previousTemplate = owner.style.getPropertyValue("--resized-library-columns");
    handle.setPointerCapture(pointerId);
    document.documentElement.dataset.columnResizing = "true";

    function move(moveEvent: globalThis.PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const resized = resizeColumnPair(widths, key, right!, moveEvent.clientX - startX);
      if (resized !== widths) remember(resized);
    }
    function dispose() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("blur", cancel);
      handle.removeEventListener("lostpointercapture", cancel);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      delete document.documentElement.dataset.columnResizing;
      cleanup.current = null;
    }
    function finish(upEvent: globalThis.PointerEvent) {
      if (upEvent.pointerId !== pointerId) return;
      const resized = resizeColumnPair(widths, key, right!, upEvent.clientX - startX);
      if (resized !== widths) remember(resized);
      dispose();
    }
    function cancel() {
      preferred.current = previousPreference;
      if (previousTemplate) owner.style.setProperty("--resized-library-columns", previousTemplate);
      else owner.style.removeProperty("--resized-library-columns");
      dispose();
    }
    function keyDown(keyEvent: globalThis.KeyboardEvent) {
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        cancel();
      }
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("blur", cancel);
    handle.addEventListener("lostpointercapture", cancel);
    cleanup.current = dispose;
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLButtonElement>, key: ColumnKey) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const right = neighbor(key);
    if (!right) return;
    event.preventDefault();
    event.stopPropagation();
    const step = (event.shiftKey ? 40 : 10) * (event.key === "ArrowLeft" ? -1 : 1);
    const widths = measuredWidths();
    const resized = resizeColumnPair(widths, key, right, step);
    if (resized !== widths) remember(resized);
  }

  return <div className="columnInfo" ref={headerRef}>
    {/* Holds the artwork column, so optional columns fill in after the standard ones. */}
    <span className="columnLeadingSpacer" aria-hidden="true" />
    {shownColumns.map((column, index) => {
      const direction = sort?.key === column.key ? sort.direction : null;
      const nextLabel = direction === "descending" ? `Sort ${column.label} ascending`
        : direction === "ascending" ? "Return to date-added order" : `Sort ${column.label} descending`;
      return <div key={column.key} className={`${column.className} columnHeaderCell${isOptionalColumn(column.key) ? " extraColumn" : ""}`}>
        {onSortChange ? <button className="columnSortButton" type="button"
          data-sort-direction={direction ?? undefined} aria-label={nextLabel} data-tooltip={nextLabel}
          onClick={() => onSortChange(nextTrackSort(sort, column.key))}>
          <span>{column.label}</span>
          {direction && <span className="columnSortIndicator" aria-hidden="true">{direction === "descending" ? "↓" : "↑"}</span>}
        </button> : <span>{column.label}</span>}
        {index < shownColumns.length - 1 && <button className="columnResizeHandle" type="button"
          aria-label={`Resize ${column.label} column`} onPointerDown={event => startResize(event, column.key)}
          onKeyDown={event => resizeWithKeyboard(event, column.key)} onClick={event => event.stopPropagation()} />}
      </div>;
    })}
    <ColumnPicker />
  </div>;
}

function anchorPosition(button: HTMLElement) {
  const rect = button.getBoundingClientRect();
  return { top: rect.bottom + 6, right: window.innerWidth - rect.right };
}

/** Chooses the optional columns, which every song list then shows. */
function ColumnPicker() {
  const { extra, setExtra } = useTrackColumns();
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = position !== null;

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role='menuitemcheckbox']")?.focus();
    const closeOutside = (event: globalThis.PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setPosition(null);
    };
    // The header is sticky, so the menu follows its button rather than closing as the page scrolls.
    const follow = () => { if (button.current) setPosition(anchorPosition(button.current)); };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (!isUnmodifiedKey(event, "Escape")) return;
      event.preventDefault();
      event.stopPropagation();
      setPosition(null);
      button.current?.focus();
    };
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
    };
  }, [open]);

  function toggle() {
    if (open || !button.current) {
      setPosition(null);
      return;
    }
    setPosition(anchorPosition(button.current));
  }

  // Up and Down move between choices, as in a native menu.
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitemcheckbox']")];
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  }

  return <div className="columnPicker">
    <button ref={button} type="button" className="columnPickerButton" aria-label="Choose columns" data-tooltip="Choose columns"
      aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12M2 8h12M2 13h12M6 1.5v3M10 6.5v3M5 11.5v3" /></svg>
    </button>
    {position && <div ref={menu} className="columnPickerMenu" role="menu" aria-label="Columns" onKeyDown={moveFocus}
      style={{ top: position.top, right: position.right }}>
      <span className="columnPickerHeading" aria-hidden="true">Show columns</span>
      {optionalTrackColumns.map(column => {
        const checked = extra.includes(column.key);
        return <button key={column.key} type="button" role="menuitemcheckbox" aria-checked={checked} className="columnPickerOption"
          onClick={() => setExtra(checked ? extra.filter(key => key !== column.key) : [...extra, column.key])}>
          <span className="columnPickerCheck" aria-hidden="true" />{column.label}
        </button>;
      })}
    </div>}
  </div>;
}
