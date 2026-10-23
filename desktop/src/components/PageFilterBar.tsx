import { useEffect, useRef } from "react";
import { isUnmodifiedKey } from "../utils/keyboard";
import { usePageFilter } from "../hooks/usePageFilter";
import "./PageFilterBar.css";

type Props = {
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  /** Changes whenever / is pressed again, to bring focus back. */
  focusRequest: number;
};

/** Narrows the songs on the current page; the app-wide search stays separate. */
export function PageFilterBar({ query, onQueryChange, onClose, focusRequest }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const { matches } = usePageFilter();

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);

  return <div className="pageFilter" role="search" aria-label="Filter songs on this page">
    <input ref={input} className="pageFilterInput" value={query} placeholder="Filter"
      aria-label="Filter songs on this page" spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
      onChange={event => onQueryChange(event.target.value)}
      onBlur={() => { if (!query.trim()) onClose(); }}
      onKeyDown={event => {
        if (isUnmodifiedKey(event.nativeEvent, "Escape")) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (isUnmodifiedKey(event.nativeEvent, "Enter")) {
          event.preventDefault();
          // Keeps the filter, and hands the keyboard back to playback shortcuts.
          input.current?.blur();
        }
      }} />
    {query.trim() && <span className="pageFilterCount" aria-live="polite">
      {matches === 0 ? "No matches" : `${matches.toLocaleString()} ${matches === 1 ? "song" : "songs"}`}
    </span>}
    <button type="button" className="pageFilterClose" aria-label="Close filter" data-tooltip="Close (Esc)"
      onMouseDown={event => event.preventDefault()} onClick={onClose} />
  </div>;
}
