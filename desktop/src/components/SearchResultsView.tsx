import type { SearchProvider } from "../api/server";
import type { GlobalTrackId, Track } from "../types/music";
import { TrackList } from "./TrackList";
import "./TracksView.css";

type SearchResultsViewProps = {
  query: string;
  provider: SearchProvider;
  tracks: Track[];
  isSearching: boolean;
  error: string | null;
  playTrack: (trackId: GlobalTrackId) => void;
  playStandalone: (trackId: GlobalTrackId) => void;
  addToQueue: (trackId: GlobalTrackId) => void;
  playNext: (trackId: GlobalTrackId) => void;
};

const providerNames: Record<SearchProvider, string> = {
  tidal: "Tidal",
  qobuz: "Qobuz",
  spotify: "Spotify",
};

export function SearchResultsView({
  query,
  provider,
  tracks,
  isSearching,
  error,
  playTrack,
  playStandalone,
  addToQueue,
  playNext,
}: SearchResultsViewProps) {
  let status = `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"} from ${providerNames[provider]}`;
  if (isSearching) status = `Searching ${providerNames[provider]}…`;
  else if (error) status = error;
  else if (tracks.length === 0) status = "No songs found";

  return (
    <div className="tracksView searchResultsView">
      <div className="libraryHeader searchResultsHeader">
        <h1 className="libraryTitle">Search</h1>
        <p className="searchQuery">Results for “{query.trim()}”</p>
        <p
          className="searchStatus"
          role={error ? "alert" : "status"}
          data-error={error ? "true" : undefined}
        >
          {status}
        </p>
      </div>
      {!isSearching && !error && tracks.length > 0 && (
        <TrackList
          tracks={tracks}
          playTrack={playTrack}
          playStandalone={playStandalone}
          addToQueue={addToQueue}
          playNext={playNext}
        />
      )}
    </div>
  );
}
