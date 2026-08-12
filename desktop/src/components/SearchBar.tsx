import "./SearchBar.css";
import type { SearchProvider } from "../api/server";

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
  return (
    <div id="searchBar" role="search">
      <input
        id="input"
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="What are you itching for?"
        aria-label="Search songs"
        autoComplete="off"
      />
      <select
        id="select"
        value={provider}
        onChange={(event) =>
          onProviderChange(event.target.value as SearchProvider)
        }
        aria-label="Music service"
      >
        <option value="tidal">Tidal</option>
        <option value="qobuz">Qobuz</option>
        <option value="spotify">Spotify</option>
      </select>
    </div>
  );
}
