import { useEffect, useMemo, useState } from "react";
import { loadAlbumInfo, type AlbumInfo, type CatalogAlbum } from "../api/server";
import type { Track } from "../types/music";
import { artistBiography } from "../utils/artistPage";
import { musicProviderName } from "../utils/musicProviderName";
import { trackRanges } from "../utils/trackCredits";
import { CreditList } from "./CreditList";

/** The album's description and everyone credited across its tracks, from Qobuz or Tidal. */
export function AlbumAbout({ album, track }: { album: CatalogAlbum; track?: Track }) {
  const [info, setInfo] = useState<AlbumInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
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
  const rows = useMemo(() => (info?.credits ?? []).map(group => ({
    role: group.role,
    entries: group.contributors.map(contributor => ({
      name: contributor.name,
      detail: contributor.tracks.length
        ? `${contributor.tracks.length === 1 ? "Track" : "Tracks"} ${trackRanges(contributor.tracks)}`
        : undefined,
    })),
  })), [info]);

  if (album.provider === "local") return null;
  return (
    <section className="artistAbout albumAbout" aria-busy={!info && !error}>
      {error ? (
        <p className="artistStatus" role="alert">
          {error} <button type="button" className="entityLink" onClick={() => setAttempt(value => value + 1)}>Retry</button>
        </p>
      ) : !info ? (
        <p className="artistStatus" role="status">Loading album info…</p>
      ) : !info.source ? (
        <><h2 className="entitySectionTitle">About</h2><p>No info is available for this album.</p></>
      ) : (
        <>
          {!!description.length && <>
            <h2 className="entitySectionTitle">About</h2>
            <div className="artistBiography" data-expanded={expanded}>{description.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
            <button type="button" className="artistTextAction" onClick={() => setExpanded(value => !value)}>{expanded ? "Show less" : "Read more"}</button>
            {info.descriptionSource && <p className="artistBiographySource">{info.descriptionSource}</p>}
          </>}
          {!!rows.length && <><h2 className="entitySectionTitle">Credits</h2><CreditList rows={rows} /></>}
          {(info.label || info.copyright) && (
            <p className="albumInfoRelease">{[info.label, info.copyright].filter(Boolean).join(" · ")}</p>
          )}
          <p className="albumInfoSource">Info from {musicProviderName(info.source)}</p>
        </>
      )}
    </section>
  );
}
