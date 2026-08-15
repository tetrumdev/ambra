import "./SearchBar.css";
import { useRef, useState, type KeyboardEvent } from "react";
import type { SearchProvider } from "../api/server";

const providerOptions: Array<{ value: SearchProvider; label: string }> = [
  { value: "tidal", label: "Tidal" },
  { value: "qobuz", label: "Qobuz" },
  { value: "spotify", label: "Spotify" },
];

type SearchBarProps = {
  query: string;
  provider: SearchProvider;
  onQueryChange: (query: string) => void;
  onProviderChange: (provider: SearchProvider) => void;
};

export function SearchBar({
  query,
  provider,
  onQueryChange,
  onProviderChange,
}: SearchBarProps) {
  const [menuIsOpen, setMenuIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = providerOptions.findIndex(
    (option) => option.value === provider,
  );
  const selectedProvider = providerOptions[selectedIndex];

  function focusOption(index: number) {
    const optionCount = providerOptions.length;
    optionRefs.current[(index + optionCount) % optionCount]?.focus();
  }

  function openMenuAndFocus(index: number) {
    setMenuIsOpen(true);
    requestAnimationFrame(() => focusOption(index));
  }

  function selectProvider(nextProvider: SearchProvider) {
    onProviderChange(nextProvider);
    setMenuIsOpen(false);
    triggerRef.current?.focus();
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenuAndFocus(selectedIndex);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenuAndFocus(selectedIndex - 1);
    } else if (event.key === "Escape" && menuIsOpen) {
      event.preventDefault();
      setMenuIsOpen(false);
    }
  }

  function handleOptionKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(providerOptions.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setMenuIsOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div
      id="searchBar"
      role="search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setMenuIsOpen(false);
        }
      }}
    >
      <input
        id="input"
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") {
            event.currentTarget.blur();
          }
        }}
        placeholder="Search..."
        aria-label="Search songs"
        autoComplete="off"
      />
      <button
        ref={triggerRef}
        id="serviceSelect"
        type="button"
        aria-label="Music service"
        aria-haspopup="menu"
        aria-expanded={menuIsOpen}
        aria-controls="serviceMenu"
        onClick={() => setMenuIsOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selectedProvider.label}</span>
        <span className="serviceChevron" aria-hidden="true" />
      </button>
      {menuIsOpen && (
        <div id="serviceMenu" role="menu" aria-label="Music service">
          {providerOptions.map((option, index) => (
            <button
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              className="serviceOption"
              type="button"
              role="menuitemradio"
              aria-checked={option.value === provider}
              data-selected={option.value === provider ? "true" : undefined}
              key={option.value}
              onClick={() => selectProvider(option.value)}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              <span>{option.label}</span>
              {option.value === provider && (
                <img
                  className="serviceCheck"
                  src="/check.svg"
                  alt=""
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
