import "./SearchBar.css";
import { isUnmodifiedKey } from "../utils/keyboard";
import type { SearchProvider, StreamingProvider } from "../api/server";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FadeOutOnClose } from "../hooks/useFadeOutOnUnmount";

const providerNames: Record<SearchProvider, string> = {
  all: "All services",
  tidal: "Tidal",
  qobuz: "Qobuz",
  spotify: "Spotify",
};

const providerIcons: Record<SearchProvider, string> = {
  all: "/routedSearch.svg",
  tidal: "/tidalIcon.svg",
  qobuz: "/qobuzIcon.svg",
  spotify: "/spotifyIcon.svg",
};

const searchIcon = "/searchIcon.svg";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState(Boolean(query));
  const input = useRef<HTMLInputElement>(null);
  const inputControl = useRef<HTMLDivElement>(null);
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
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
    setMenuOpen(false);
    if (input.current) {
      focusPending();
      return;
    }
    // The collapsed width is laid out first, so the bar widens the same way a click does.
    void inputControl.current?.offsetWidth;
    setSearchExpanded(true);
  }, [focusRequest]);

  useEffect(() => {
    if (!menuOpen) return;
    menu.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!control.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [menuOpen]);

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
      <div
        className="searchProviderControl"
        ref={control}
        onKeyDown={(event) => {
          if (event.key === "Escape" && menuOpen) {
            event.preventDefault();
            event.stopPropagation();
            setMenuOpen(false);
            trigger.current?.focus();
            return;
          }
          if (
            !menuOpen &&
            event.target === trigger.current &&
            (event.key === "ArrowDown" || event.key === "ArrowUp")
          ) {
            event.preventDefault();
            setMenuOpen(true);
            return;
          }
          if (
            !menuOpen ||
            !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          )
            return;
          const items = [
            ...(menu.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitemradio"]',
            ) ?? []),
          ];
          const index = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) %
                  items.length;
          event.preventDefault();
          items[next]?.focus();
        }}
      >
        <button
          id="searchProvider"
          ref={trigger}
          type="button"
          aria-label={`Search service: ${providerNames[provider]}`}
          data-tooltip={`Searching ${providerNames[provider]}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? "searchProviderMenu" : undefined}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <img
            className="searchProviderIcon"
            src={providerIcons[provider]}
            alt=""
            aria-hidden="true"
          />
        </button>
        {menuOpen && (
          <FadeOutOnClose>
            <div
              id="searchProviderMenu"
              className="searchProviderMenu"
              ref={menu}
              role="menu"
              aria-label="Search service"
            >
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={provider === option}
                  aria-label={providerNames[option]}
                  data-tooltip={providerNames[option]}
                  onClick={() => {
                    onProviderChange(option);
                    setMenuOpen(false);
                    trigger.current?.focus();
                  }}
                >
                  <img
                    className="searchProviderIcon"
                    src={providerIcons[option]}
                    alt=""
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          </FadeOutOnClose>
        )}
      </div>
    </div>
  );
}
