import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { nextTrackSort, type TrackSort } from "../utils/trackCollectionOrder";
import { resizeColumnPair, trackColumns, type ColumnKey, type ColumnWidths } from "../utils/trackColumnWidths";
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

  function visibleColumns() {
    const header = headerRef.current;
    return header ? trackColumns.filter(column => {
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
    {trackColumns.map((column, index) => {
      const direction = sort?.key === column.key ? sort.direction : null;
      const nextLabel = direction === "descending" ? `Sort ${column.label} ascending`
        : direction === "ascending" ? "Return to date-added order" : `Sort ${column.label} descending`;
      return <div key={column.key} className={`${column.className} columnHeaderCell`}>
        {onSortChange ? <button className="columnSortButton" type="button"
          data-sort-direction={direction ?? undefined} aria-label={nextLabel} data-tooltip={nextLabel}
          onClick={() => onSortChange(nextTrackSort(sort, column.key))}>
          <span>{column.label}</span>
          {direction && <span className="columnSortIndicator" aria-hidden="true">{direction === "descending" ? "↓" : "↑"}</span>}
        </button> : <span>{column.label}</span>}
        {index < trackColumns.length - 1 && <button className="columnResizeHandle" type="button"
          aria-label={`Resize ${column.label} column`} onPointerDown={event => startResize(event, column.key)}
          onKeyDown={event => resizeWithKeyboard(event, column.key)} onClick={event => event.stopPropagation()} />}
      </div>;
    })}
  </div>;
}
