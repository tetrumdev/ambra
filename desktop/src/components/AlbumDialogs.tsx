import { useEffect, useMemo, useRef, useState } from "react";
import { loadAlbumInfo, type AlbumInfo, type CatalogAlbum, type CatalogArtist } from "../api/server";
import type { Track } from "../types/music";
import { catalogAlbumQuality, findAlbumVersions } from "../utils/albumVersions";
import { closeDialog, openDialog } from "../utils/dialogs";
import { musicProviderName } from "../utils/musicProviderName";
import { isPreferredAlbumVersion, preferAlbumVersion } from "../utils/catalogRanking";
import { trackRanges } from "../utils/trackCredits";
import { CreditList } from "./CreditList";
import { ProviderIcon } from "./ProviderIcon";
import { useCreditArtists } from "../utils/creditArtists";

/** Runs a dialog element from `open`, closing it through `onClose` on Escape too. */
function useDialog(open: boolean) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) openDialog(dialog.current);
    else closeDialog(dialog.current);
  }, [open]);
  return dialog;
}

/** Everyone credited across the album's tracks, like a song's Credits dialog. */
export function AlbumCreditsDialog({ album, tracks, open, onClose, onOpenArtist }: {
  album: CatalogAlbum;
  /** The album's tracks; the first helps find the release, and their artists link directly. */
  tracks: Track[];
  open: boolean;
  onClose: () => void;
  onOpenArtist: (artist: CatalogArtist) => void;
}) {
  const dialog = useDialog(open);
  const track = tracks[0];
  const [info, setInfo] = useState<AlbumInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setInfo(null);
    setError(null);
    void loadAlbumInfo(album, track, controller.signal)
      .then(value => { if (!controller.signal.aborted) setInfo(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [open, album.id, album.provider, Boolean(track), attempt]);
  const rows = useMemo(() => (info?.credits ?? []).map(group => ({
    role: group.role,
    entries: group.contributors.map(contributor => ({
      name: contributor.name,
      detail: contributor.tracks.length
        ? `${contributor.tracks.length === 1 ? "Track" : "Tracks"} ${trackRanges(contributor.tracks)}`
        : undefined,
    })),
  })), [info]);
  const names = useMemo(() => (info?.credits ?? []).flatMap(group => group.contributors.map(contributor => contributor.name)), [info]);
  const catalogIds = useMemo(() => Object.fromEntries((info?.credits ?? []).flatMap(group => group.contributors
    .flatMap(contributor => contributor.artistId ? [[contributor.name, contributor.artistId]] : []))), [info]);
  const artistFor = useCreditArtists(names, info?.source ?? null, catalogIds, tracks);

  return (
    <dialog
      ref={dialog}
      className="playlistEditDialog creditsDialog"
      aria-label={`Credits for ${album.title}`}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onKeyDown={event => event.stopPropagation()}
    >
      <button type="button" className="playlistEditCancel" onClick={onClose}>Close</button>
      <div className="playlistEditContent">
        <div>
          <h2>{album.title}</h2>
          <p>{album.artist}</p>
        </div>
        {error ? (
          <p role="alert">
            {error}{" "}
            <button type="button" className="creditsRetry" onClick={() => setAttempt(value => value + 1)}>Retry</button>
          </p>
        ) : !info ? (
          <p role="status">Loading credits…</p>
        ) : rows.length ? (
          <>
            <div className="creditsScroll">
              <CreditList rows={rows} artistFor={artistFor} onOpenArtist={artist => { onClose(); onOpenArtist(artist); }} />
            </div>
            {info.source && <p className="creditsSource">Credits from {musicProviderName(info.source)}</p>}
          </>
        ) : (
          <p>No credits are available for this album.</p>
        )}
      </div>
    </dialog>
  );
}

/** The album on each connected service and its other editions, to open the preferred one. */
export function AlbumVersionsDialog({ album, open, onClose, onSelect }: {
  album: CatalogAlbum;
  open: boolean;
  onClose: () => void;
  onSelect: (version: CatalogAlbum) => void;
}) {
  const dialog = useDialog(open);
  const [versions, setVersions] = useState<CatalogAlbum[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setVersions(null);
    setError(null);
    void findAlbumVersions(album, controller.signal)
      .then(value => { if (!controller.signal.aborted) setVersions(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [open, album.id, album.provider, attempt]);

  return (
    <dialog
      ref={dialog}
      className="playlistEditDialog creditsDialog albumVersionsDialog"
      aria-label={`Versions of ${album.title}`}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onKeyDown={event => event.stopPropagation()}
    >
      <button type="button" className="playlistEditCancel" onClick={onClose}>Close</button>
      <div className="playlistEditContent">
        <div>
          <h2>Versions</h2>
          <p>{album.title} · {album.artist}</p>
        </div>
        {error ? (
          <p role="alert">
            {error}{" "}
            <button type="button" className="creditsRetry" onClick={() => setAttempt(value => value + 1)}>Retry</button>
          </p>
        ) : !versions ? (
          <p role="status">Finding versions…</p>
        ) : (
          <ul className="creditsScroll albumVersionList">
            {versions.map(version => {
              const current = version.provider === album.provider && version.id === album.id;
              const preferred = isPreferredAlbumVersion(version);
              const edition = version.version && !version.title.toLowerCase().includes(version.version.toLowerCase()) ? version.version : null;
              const details = [version.releaseDate?.slice(0, 4), version.releaseType, catalogAlbumQuality(version)].filter(Boolean).join(" · ");
              return (
                <li key={`${version.provider}:${version.id}`}>
                  <button type="button" className="albumVersion" aria-current={current ? "true" : undefined}
                    onClick={() => {
                      // The pick is remembered, so this album opens on it from search and artist pages too.
                      preferAlbumVersion(version);
                      onClose();
                      if (!current) onSelect({ ...version, versions: versions.map(({ versions: _, ...source }) => source) });
                    }}>
                    {version.imageUrl
                      ? <img className="albumVersionCover" src={version.imageUrl} alt="" draggable={false} />
                      : <span className="albumVersionCover" aria-hidden="true" />}
                    <span className="albumVersionText">
                      <span className="albumVersionTitle">
                        {version.title}{edition && <span className="albumVersionEdition"> · {edition}</span>}
                        {version.explicit && <span className="albumVersionExplicit" aria-label="Explicit">E</span>}
                      </span>
                      <span className="albumVersionDetails">
                        <ProviderIcon provider={version.provider} />
                        {details && <span>{details}</span>}
                      </span>
                    </span>
                    {(current || preferred) && <span className="albumVersionState">{current ? "Open" : "Preferred"}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </dialog>
  );
}
