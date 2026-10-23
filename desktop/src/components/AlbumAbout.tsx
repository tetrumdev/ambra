import { useEffect, useMemo, useState } from "react";
import { loadAlbumInfo, type AlbumInfo, type CatalogAlbum } from "../api/server";
import type { Track } from "../types/music";
import { artistBiography } from "../utils/artistPage";
import { musicProviderName } from "../utils/musicProviderName";

/** The album's description and release details, from Qobuz or Tidal; its credits open from the header. */
export function AlbumAbout({ album, track }: { album: CatalogAlbum; track?: Track }) {
  const [info, setInfo] = useState<AlbumInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A recording helps find the release where a UPC can't, so wait for the tracklist when it's coming.
  const hasTrack = Boolean(track);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void loadAlbumInfo(album, track, controller.signal)
      .then(value => { if (!controller.signal.aborted) setInfo(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [album.id, album.provider, hasTrack, attempt]);
  const description = useMemo(() => artistBiography(info?.description), [info?.description]);

  if (album.provider === "local") return null;
  return (
    <div aria-busy={!info && !error}>
      {error ? (
        <p role="alert">
          {error} <button type="button" className="entityLink" onClick={() => setAttempt(value => value + 1)}>Retry</button>
        </p>
      ) : !info ? (
        <p role="status">Loading album info…</p>
      ) : !info.source ? (
        <p>No info is available for this album.</p>
      ) : (
        <>
          {!!description.length && <>
            {description.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
            {info.descriptionSource && <p className="creditsSource">{info.descriptionSource}</p>}
          </>}
          {(info.label || info.copyright) && (
            <p>{[info.label, info.copyright].filter(Boolean).join(" · ")}</p>
          )}
          <p className="creditsSource">Info from {musicProviderName(info.source)}</p>
        </>
      )}
    </div>
  );
}
