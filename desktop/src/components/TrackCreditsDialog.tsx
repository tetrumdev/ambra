import { useEffect, useRef, useState } from "react";
import { loadTrackCredits, type TrackCredits } from "../api/server";
import type { Track } from "../types/music";
import { closeDialog, openDialog } from "../utils/dialogs";
import { musicProviderName } from "../utils/musicProviderName";
import { showTrackCredits, useShownTrackCredits } from "../utils/trackCredits";
import { CreditList } from "./CreditList";

export function TrackCreditsDialog() {
  const shown = useShownTrackCredits();
  // The closing dialog keeps showing its song while it fades.
  const [track, setTrack] = useState<Track | null>(shown);
  const [credits, setCredits] = useState<TrackCredits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (shown) {
      setTrack(shown);
      openDialog(dialog.current);
    } else closeDialog(dialog.current);
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    const controller = new AbortController();
    setCredits(null);
    setError(null);
    void loadTrackCredits(shown, controller.signal)
      .then(value => { if (!controller.signal.aborted) setCredits(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [shown, attempt]);

  return (
    <dialog
      ref={dialog}
      className="playlistEditDialog creditsDialog"
      aria-label={track ? `Credits for ${track.name}` : "Credits"}
      onCancel={event => {
        event.preventDefault();
        showTrackCredits(null);
      }}
      onKeyDown={event => event.stopPropagation()}
    >
      <button type="button" className="playlistEditCancel" onClick={() => showTrackCredits(null)}>Close</button>
      <div className="playlistEditContent">
        <div>
          <h2>{track?.name}</h2>
          <p>{track?.artist}</p>
        </div>
        {error ? (
          <p role="alert">
            {error}{" "}
            <button type="button" className="creditsRetry" onClick={() => setAttempt(value => value + 1)}>Retry</button>
          </p>
        ) : !credits ? (
          <p role="status">Loading credits…</p>
        ) : credits.credits.length ? (
          <>
            <div className="creditsScroll">
              <CreditList rows={credits.credits.map(group => ({ role: group.role, entries: group.names.map(name => ({ name })) }))} />
            </div>
            {credits.source && <p className="creditsSource">Credits from {musicProviderName(credits.source)}</p>}
          </>
        ) : (
          <p>No credits are available for this song.</p>
        )}
      </div>
    </dialog>
  );
}
