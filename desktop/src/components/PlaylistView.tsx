import { useEffect, useMemo, useState } from "react";
import type { Playlist, Track } from "../types/music";
import type { PlaylistImprovementProgress, PlaylistImprovementReport } from "../hooks/usePlaylistImprovement";
import { TrackCollectionView, type TrackCollectionViewProps } from "./TrackCollectionView";
import { TrackArtwork } from "./TrackArtwork";
import { PlaylistActions } from "./PlaylistActions";
import { exportPlaylist } from "../utils/playlistExport";

type PlaylistViewProps = Omit<
  TrackCollectionViewProps,
  "title" | "removalLabel" | "collapsibleHeader" | "headerArtwork" | "playbackActions"
> & {
  playlist: Playlist;
  artworkTracks: Track[];
  /** Only editable playlists can be renamed or deleted, and only AMBRA playlists improved. */
  onRename?: (id: string, name: string) => boolean | Promise<boolean>;
  onDelete?: (id: string) => boolean | Promise<boolean>;
  onDuplicate: () => void;
  onImprove?: () => void;
  /** The scan the user asked for, on any playlist. */
  improvementProgress: PlaylistImprovementProgress | null;
  improvementReport?: PlaylistImprovementReport;
  onExit: (playlistId: string) => void;
};

function improvementMessage(progress: PlaylistImprovementProgress | null, report?: PlaylistImprovementReport) {
  if (progress) return `Checking ${progress.done} of ${progress.total} songs…`;
  if (report?.error) return report.error;
  const upgraded = report?.upgrades.length ?? 0;
  // A change can also move a song off a compilation, or reunite a package, at the same quality.
  if (upgraded === 0) return "Every song is already on the best copy available.";
  return `Moved ${upgraded} song${upgraded === 1 ? "" : "s"} to ${upgraded === 1 ? "a better copy" : "better copies"}.`;
}

export function PlaylistView({
  playlist,
  artworkTracks,
  onRename,
  onDelete,
  onDuplicate,
  onImprove,
  improvementProgress,
  improvementReport,
  onExit,
  tracks,
  ...props
}: PlaylistViewProps) {
  // What a scan reported belongs to this visit; leaving the playlist clears it.
  useEffect(() => () => onExit(playlist.id), [onExit, playlist.id]);
  const [showingUpgrades, setShowingUpgrades] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    // The playlist's own order, every song, whatever the view is sorted or filtered by.
    try { await exportPlaylist(playlist.name, artworkTracks); }
    catch (reason) { setExportError(String(reason)); }
    finally { setExporting(false); }
  };
  const progress = improvementProgress?.playlistId === playlist.id ? improvementProgress : null;
  const upgradedIds = useMemo(
    () => new Set(improvementReport?.upgrades.map(upgrade => upgrade.to.globalId)),
    [improvementReport],
  );
  const canShow = !progress && upgradedIds.size > 0;

  return (
    <TrackCollectionView
      {...props}
      tracks={canShow && showingUpgrades ? tracks.filter(track => upgradedIds.has(track.globalId)) : tracks}
      title={playlist.name}
      showProviderIcon
      removalLabel="Remove from Playlist"
      collapsibleHeader
      playbackActions={
        <>
          <PlaylistActions
            playlist={playlist}
            className="libraryMoreBtn"
            onRename={onRename}
            onDelete={onDelete}
            actions={[
              { label: "Duplicate Playlist", icon: "/duplicate.svg", onSelect: onDuplicate },
              ...(onImprove ? [{
                label: improvementProgress ? "Improving…" : "Improve Playlist",
                icon: "/sparkle.svg",
                disabled: Boolean(improvementProgress) || artworkTracks.length === 0,
                onSelect: onImprove,
              }] : []),
              {
                label: exporting ? "Exporting…" : "Export Playlist",
                icon: "/duplicate.svg",
                disabled: exporting || artworkTracks.length === 0,
                onSelect: () => void exportCsv(),
              },
            ]}
          >
            <img src="/menu.svg" alt="" aria-hidden="true" />
          </PlaylistActions>
          {exportError && (
            <p className="playlistImproveStatus" role="alert"><span>{exportError}</span></p>
          )}
          {(progress || improvementReport) && (
            <p className="playlistImproveStatus" role="status">
              <span>{improvementMessage(progress, improvementReport)}</span>
              {canShow && (
                <button type="button" className="playlistImproveShow" onClick={() => setShowingUpgrades(value => !value)}>
                  {showingUpgrades ? "Hide" : "Show"}
                </button>
              )}
            </p>
          )}
        </>
      }
      headerArtwork={
        <div className="playlistArtworkGrid" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => {
            const track = artworkTracks[index];
            return track ? (
              <TrackArtwork
                key={`${track.globalId}:${index}`}
                track={track}
                alt=""
              />
            ) : (
              <span key={`empty:${index}`} />
            );
          })}
        </div>
      }
    />
  );
}
