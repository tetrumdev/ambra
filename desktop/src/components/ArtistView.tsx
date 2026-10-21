import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cachedArtistAlbums, cachedArtistProfile, loadArtistAlbums, loadArtistBiography, loadArtistProfile, type ArtistBiography, type ArtistProfile, type CatalogAlbum, type CatalogArtist } from "../api/server";
import { rememberArtistImage } from "../utils/artistImages";
import { libraryAlbums } from "../utils/librarySections";
import { artistBiography, artistReleaseSections, artistSources, biographyProviders, mergedArtistReleases, trustedArtistSources } from "../utils/artistPage";
import { musicProviderName } from "../utils/musicProviderName";
import { entityKey, entityProvider, tracksForEntity } from "../utils/browse";
import { ArtistPortrait } from "./ArtistPortrait";
import { CatalogAlbumGrid } from "./LibraryView";
import { TrackCollectionView } from "./TrackCollectionView";
import { TrackList } from "./TrackList";
import type { EntityViewProps } from "./EntityView";
import "./ArtistView.css";

export function ArtistView({ artist, ...props }: EntityViewProps & { artist: CatalogArtist }) {
  const key = entityKey(props.entity);
  const cached = props.cache.get(key);
  const initialProfile = cached?.profile ?? cachedArtistProfile(artist);
  const initialSources = cached?.sources ?? artist.sources ?? [artist];
  const [profile, setProfile] = useState<ArtistProfile | undefined>(initialProfile);
  // The artist is one discography across services; this entry supplies the profile and popular tracks.
  const [sources, setSources] = useState<CatalogArtist[]>(initialSources);
  const [sourcesFound, setSourcesFound] = useState(false);
  type Releases = Record<string, { albums: CatalogAlbum[]; nextOffset: number | null }>;
  const [releases, setReleases] = useState<Releases>(() => cached?.releases ?? Object.fromEntries(
    initialSources.flatMap(source => { const page = cachedArtistAlbums(source); return page ? [[source.id, page]] : []; }),
  ));
  const albumsLoaded = !!releases[artist.id];
  const [profileError, setProfileError] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(artist.provider !== "local" && !initialProfile);
  const [loadingReleases, setLoadingReleases] = useState(0);
  const releasesLoading = loadingReleases > 0;
  const [profileAttempt, setProfileAttempt] = useState(0);
  const [expandedPopular, setExpandedPopular] = useState(cached?.expandedPopular ?? false);
  const [expandedBiography, setExpandedBiography] = useState(cached?.expandedBiography ?? false);
  useEffect(() => {
    if (artist.provider === "local" || (initialProfile && profileAttempt === 0)) return;
    const controller = new AbortController(); setProfileLoading(true); setProfileError(null);
    void loadArtistProfile(artist, controller.signal, profileAttempt > 0).then(value => { if (!controller.signal.aborted) setProfile(value); })
      .catch(reason => { if (!controller.signal.aborted) setProfileError(String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setProfileLoading(false); });
    return () => controller.abort();
  }, [artist.id, artist.provider, profileAttempt]);
  useEffect(() => {
    if (artist.provider === "local") return;
    let live = true;
    void artistSources({ ...artist, sources: initialSources }).then(found => { if (live) { setSources(found); setSourcesFound(true); } });
    return () => { live = false; };
  }, [artist.id, artist.provider]);
  const releaseController = useRef<AbortController | null>(null);
  const requestedReleases = useRef(new Set<string>());
  useEffect(() => {
    const controller = new AbortController();
    releaseController.current = controller;
    return () => { controller.abort(); requestedReleases.current.clear(); };
  }, [artist.id]);
  const loadReleases = useCallback((targets: { source: CatalogArtist; offset: number }[], refresh = false) => {
    const signal = releaseController.current?.signal;
    if (!signal) return;
    for (const { source, offset } of targets) {
      setLoadingReleases(count => count + 1);
      if (source.id === artist.id) setReleaseError(null);
      void loadArtistAlbums(source, offset, signal, refresh).then(page => {
        if (signal.aborted) return;
        setReleases(current => ({ ...current, [source.id]: {
          albums: [...new Map([...(offset ? current[source.id]?.albums ?? [] : []), ...page.albums].map(album => [album.id, album])).values()],
          nextOffset: page.nextOffset,
        } }));
      }).catch(reason => {
        // Other services only fill in; the page reports trouble with its own service.
        if (!signal.aborted && source.id === artist.id) setReleaseError(String(reason));
      }).finally(() => { if (!signal.aborted) setLoadingReleases(count => count - 1); });
    }
  }, [artist.id]);
  useEffect(() => {
    if (artist.provider === "local") return;
    const targets = sources.filter(source => !releases[source.id] && !requestedReleases.current.has(source.id));
    for (const source of targets) requestedReleases.current.add(source.id);
    loadReleases(targets.map(source => ({ source, offset: 0 })));
  }, [artist.provider, sources, loadReleases]);
  const albums = useMemo(() => mergedArtistReleases(artist, sources, releases), [artist, sources, releases]);
  const moreReleases = sources.filter(source => releases[source.id]?.nextOffset != null);
  useEffect(() => {
    props.cache.set(key, { profile, sources, releases, expandedPopular, expandedBiography });
  }, [key, profile, sources, releases, expandedPopular, expandedBiography, props.cache]);
  useEffect(() => {
    if (!profile) return;
    props.rememberTracks(profile.popularTracks);
    rememberArtistImage(profile.artist);
  }, [profile, props.rememberTracks]);
  const saved = useMemo(() => tracksForEntity(props.entity, props.libraryTracks), [props.entity, props.libraryTracks]);
  const savedIds = useMemo(() => new Set(props.libraryTracks.map(track => track.globalId)), [props.libraryTracks]);
  const popular = useMemo(() => profile?.popularTracks ?? [], [profile]);
  const shownPopular = useMemo(() => popular.slice(0, expandedPopular ? 10 : 5), [popular, expandedPopular]);
  const playable = popular.length ? popular : saved;
  const releaseSections = useMemo(() => artistReleaseSections(artist.provider === "local" ? libraryAlbums(saved).map(album => ({ id: album.id, provider: entityProvider(album.id), title: album.name, artist: album.artist, imageUrl: album.cover, releaseDate: album.releaseYear })) : albums), [artist.provider, saved, albums]);
  // Undefined while the services that might have one are still being checked.
  const [about, setAbout] = useState<(ArtistBiography & { provider: CatalogArtist["provider"] }) | null | undefined>(undefined);
  const biographySources = useMemo(() => !sourcesFound || releasesLoading ? null
    : biographyProviders.flatMap(provider => trustedArtistSources(artist, sources, releases).filter(source => source.provider === provider)),
  [artist, sources, sourcesFound, releases, releasesLoading]);
  const biographyKey = biographySources?.map(source => source.id).join("|");
  useEffect(() => {
    if (!biographySources) return;
    const controller = new AbortController();
    void (async () => {
      for (const source of biographySources) {
        try {
          const found = await loadArtistBiography(source, controller.signal);
          if (found.biography?.trim()) return { ...found, provider: source.provider };
        } catch {
          if (controller.signal.aborted) return undefined;
        }
      }
      return null;
    })().then(found => { if (!controller.signal.aborted) setAbout(found); });
    return () => controller.abort();
  }, [biographyKey]);
  const biography = useMemo(() => artistBiography(about?.biography), [about?.biography]);
  const listProps = { playlistOptions: props.playlistOptions, onOpenEntity: props.onOpenEntity, savedTrackIds: savedIds, addToLibrary: (id: string) => { const track = [...popular, ...saved].find(track => track.globalId === id); if (track) props.onAddTrack(track); } };
  const trackList = (tracks: typeof saved, ranked = false) => <TrackList {...listProps} tracks={tracks} showRank={ranked}
    playTrack={id => props.onAction("play", ranked ? popular : saved, id)} playStandalone={id => props.onAction("standalone", tracks, id)}
    addToQueue={id => props.onAction("queue", tracks.filter(track => track.globalId === id))} playNext={id => props.onAction("next", tracks, id)} />;
  const retryProfile = () => setProfileAttempt(value => value + 1);
  return <TrackCollectionView className="entityView artistView" title={profile?.artist.name ?? artist.name} tracks={playable} summary={null}
    registerScrollElement={props.registerScrollElement} playTrack={id => props.onAction("play", playable, id)}
    playStandalone={id => props.onAction("standalone", playable, id)} addToQueue={id => props.onAction("queue", playable.filter(track => track.globalId === id))} playNext={id => props.onAction("next", playable, id)}
    shuffleCollection={() => props.onAction("shuffle", playable)}
    headerNavigation={<button type="button" className="browseBack" onClick={props.onBack}>Back</button>}
    headerArtwork={<ArtistPortrait artist={profile?.artist ?? artist} eager expandable />}
    headerContent={<p className="entityByline">Artist</p>}
    playbackActions={<button type="button" className="libraryShuffleBtn" disabled={!playable.length} onClick={() => props.onAction("queue", playable)}><img src="/add-to-queue.svg" alt="" /><span>ADD TO QUEUE</span></button>}
    content={<>
      {profileLoading && <p className="artistStatus" role="status">Loading artist…</p>}
      {profileError && <p className="artistStatus" role="alert">{profileError} <button type="button" className="entityLink" onClick={retryProfile}>Retry</button></p>}
      {profile?.popularTracksError && <p className="artistStatus" role="alert">{profile.popularTracksError} <button type="button" className="entityLink" onClick={retryProfile}>Retry</button></p>}
      {(!!popular.length || (artist.provider !== "local" && !profile)) && <section aria-busy={profileLoading}><h2 className="entitySectionTitle">Popular</h2>
        {!profile ? <div className="artistTrackSkeleton" aria-label="Loading popular tracks" role="status">{Array.from({ length: 5 }, (_, index) => <div key={index}><span /><span /></div>)}</div> : trackList(shownPopular, true)}
        {popular.length > 5 && <button type="button" className="artistTextAction" onClick={() => setExpandedPopular(value => !value)}>{expandedPopular ? "Show less" : "Show more"}</button>}
      </section>}
      {releaseSections.map(section => <section key={section.title}><h2 className="entitySectionTitle">{section.title}</h2><CatalogAlbumGrid albums={section.albums} onOpenEntity={props.onOpenEntity} /></section>)}
      {artist.provider !== "local" && !albumsLoaded && <section aria-busy={releasesLoading}><h2 className="entitySectionTitle">Albums</h2><div className="artistReleaseSkeleton" aria-label="Loading releases" role="status">{Array.from({ length: 4 }, (_, index) => <div key={index} />)}</div></section>}
      {releasesLoading && <p className="artistStatus" role="status">Loading releases…</p>}
      {releaseError && <p className="artistStatus" role="alert">{releaseError} <button type="button" className="entityLink" onClick={() => loadReleases([{ source: artist, offset: releases[artist.id]?.nextOffset ?? 0 }], true)}>Retry</button></p>}
      {moreReleases.length > 0 && <button type="button" className="artistTextAction" disabled={releasesLoading} onClick={() => loadReleases(moreReleases.map(source => ({ source, offset: releases[source.id]!.nextOffset! })))}>More releases</button>}
      {!!saved.length && <section><h2 className="entitySectionTitle">Saved songs</h2>{trackList(saved)}</section>}
      {artist.provider !== "local" && about !== undefined && <section className="artistAbout"><h2 className="entitySectionTitle">About</h2>
        {!biography.length ? <p>No info is available for this artist.</p> : <>
          <div className="artistBiography" data-expanded={expandedBiography}>{biography.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
          <button type="button" className="artistTextAction" onClick={() => setExpandedBiography(value => !value)}>{expandedBiography ? "Show less" : "Read more"}</button>
          <p className="artistBiographySource">{[about?.biographySource, about && `From ${musicProviderName(about.provider)}`].filter(Boolean).join(" · ")}</p>
        </>}
      </section>}
    </>}
  />;
}
