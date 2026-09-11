import "./SearchBar.css";

type SearchBarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  onConfirm: () => void;
};

export function SearchBar({ query, onQueryChange, onConfirm }: SearchBarProps) {
  return (
    <div id="searchBar" role="search">
      <input
        id="input"
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onConfirm();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.blur();
          }
        }}
        placeholder="Search..."
        aria-label="Search songs"
        autoComplete="off"
      />
    </div>
  );
}
