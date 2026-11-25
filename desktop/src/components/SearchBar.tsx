import "./SearchBar.css";
import { isUnmodifiedKey } from "../utils/keyboard";
import type { SearchProvider, StreamingProvider } from "../api/server";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dropdown } from "./Dropdown";

const providerNames: Record<SearchProvider, string> = {
  all: "All services",
  tidal: "Tidal",
  qobuz: "Qobuz",
  spotify: "Spotify",
};

const providerIcons: Record<SearchProvider, string> = {
  all: "/routed-search.svg",
  tidal: "/tidal.svg",
  qobuz: "/qobuz.svg",
  spotify: "/spotify.svg",
};

const searchIcon = "/search.svg";

/** Asks the bar to expand and take focus: "select" picks the whole query, "end" types on after it. */
export type SearchFocusRequest = { id: number; caret: "select" | "end" };

type SearchBarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  provider: SearchProvider;
  providers: StreamingProvider[];
  onProviderChange: (provider: SearchProvider) => void;
  onConfirm: () => void;
  focusRequest: SearchFocusRequest | null;
  /**
   * Away on pages without search: hidden at once when the page changes ("page"),
   * fading when the listener dismisses a bar summoned there ("dismissed").
   */
  away?: "page" | "dismissed";
  /** Summoned onto a page without search; it fades in. */
  summoned?: boolean;
  /** Focus left the bar for somewhere else on the page. */
  onLeave?: () => void;
};

export function SearchBar({
  query,
  onQueryChange,
  provider,
  providers,
  onProviderChange,
  onConfirm,
  focusRequest,
  away,
  summoned = false,
  onLeave,
}: SearchBarProps) {
  const [searchExpanded, setSearchExpanded] = useState(Boolean(query));
  const input = useRef<HTMLInputElement>(null);
  const inputControl = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<SearchFocusRequest["caret"] | null>(null);

  useEffect(() => {
    if (query) setSearchExpanded(true);
    else if (document.activeElement !== input.current) setSearchExpanded(false);
  }, [query]);

  // Focuses once the input exists, which on a collapsed bar is after it expands.
  const focusPending = () => {
    const field = input.current;
    const caret = pendingFocus.current;
    if (!field || !caret) return;
    pendingFocus.current = null;
    field.focus();
    if (caret === "select") field.select();
    else field.setSelectionRange(field.value.length, field.value.length);
  };
  useLayoutEffect(focusPending, [searchExpanded]);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    pendingFocus.current = focusRequest.caret;
    if (input.current) {
      focusPending();
      return;
    }
    // The collapsed width is laid out first, so the bar widens the same way a click does.
    void inputControl.current?.offsetWidth;
    setSearchExpanded(true);
  }, [focusRequest]);

  const options: SearchProvider[] = ["all", ...providers];

  return (
    <div
      id="searchBar"
      role="search"
      data-away={away}
      data-summoned={summoned || undefined}
      inert={away !== undefined}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        if (!query) setSearchExpanded(false);
        onLeave?.();
      }}
    >
      <div
        className="searchInputControl"
        ref={inputControl}
        data-expanded={searchExpanded ? "true" : undefined}
      >
        {searchExpanded ? (
          <>
            <img
              className="searchInputIcon"
              src={searchIcon}
              alt=""
              aria-hidden="true"
            />
            <input
              spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
              id="input"
              ref={input}
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (isUnmodifiedKey(event, "Enter")) {
                  event.preventDefault();
                  onConfirm();
                  event.currentTarget.blur();
                } else if (isUnmodifiedKey(event, "Escape")) {
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.blur();
                }
              }}
              placeholder="Search..."
              aria-label="Search songs"
            />
            {query && (
              <button
                className="searchClearButton"
                type="button"
                aria-label="Clear search"
                // Keeps focus in the field so typing carries on after clearing.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  onQueryChange("");
                  input.current?.focus();
                }}
              >
                <img src="/x.svg" alt="" aria-hidden="true" />
              </button>
            )}
          </>
        ) : (
          <button
            className="searchExpandButton"
            type="button"
            aria-label="Search songs"
            data-tooltip="Search"
            onClick={() => {
              pendingFocus.current = "end";
              setSearchExpanded(true);
            }}
          >
            <img src={searchIcon} alt="" aria-hidden="true" />
          </button>
        )}
      </div>
      <Dropdown label="Search service" className="searchProviderControl" iconOnly value={provider} disabled={away !== undefined}
        options={options.map(value => ({ value, label: providerNames[value], icon: providerIcons[value] }))}
        onChange={onProviderChange} />
    </div>
  );
}
