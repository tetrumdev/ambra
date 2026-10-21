import { useEffect, useMemo, useState } from "react";
import type { Playlist, Track } from "../types/music";
import type { PlaylistImprovementProgress, PlaylistImprovementReport } from "../hooks/usePlaylistImprovement";
import { TrackCollectionView, type TrackCollectionViewProps } from "./TrackCollectionView";
import { TrackArtwork } from "./TrackArtwork";
import { PlaylistActions } from "./PlaylistActions";

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
  if (upgraded === 0) return "Every song is already the best-sounding copy available.";
  return `Upgraded ${upgraded} song${upgraded === 1 ? "" : "s"} to a better-sounding copy.`;
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
            ]}
          >
            <img src="/menu.svg" alt="" aria-hidden="true" />
          </PlaylistActions>
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
