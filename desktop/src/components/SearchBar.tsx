import "./SearchBar.css";
import { isUnmodifiedKey } from "../utils/keyboard";
import type { SearchProvider, StreamingProvider } from "../api/server";
import { useEffect, useRef, useState } from "react";

const providerNames: Record<SearchProvider, string> = {
  all: "Combined",
  tidal: "Tidal",
  qobuz: "Qobuz",
  spotify: "Spotify",
};

type SearchBarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  provider: SearchProvider;
  providers: StreamingProvider[];
  onProviderChange: (provider: SearchProvider) => void;
  onConfirm: () => void;
};

export function SearchBar({ query, onQueryChange, provider, providers, onProviderChange, onConfirm }: SearchBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!control.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [menuOpen]);

  const options: SearchProvider[] = ["all", ...providers];

  return (
    <div id="searchBar" role="search">
      <input
        id="input"
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
        autoComplete="off"
      />
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
          if (!menuOpen && event.target === trigger.current && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setMenuOpen(true);
            return;
          }
          if (!menuOpen || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const items = [...menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0
            : event.key === "End" ? items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
          event.preventDefault();
          items[next]?.focus();
        }}
      >
        <button
          id="searchProvider"
          ref={trigger}
          type="button"
          aria-label={`Search service: ${providerNames[provider]}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? "searchProviderMenu" : undefined}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span>{providerNames[provider]}</span>
          <span className="searchProviderChevron" aria-hidden="true" />
        </button>
        {menuOpen && (
          <div id="searchProviderMenu" className="searchProviderMenu" ref={menu} role="menu" aria-label="Search service">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={provider === option}
                onClick={() => {
                  onProviderChange(option);
                  setMenuOpen(false);
                  trigger.current?.focus();
                }}
              >
                {providerNames[option]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
