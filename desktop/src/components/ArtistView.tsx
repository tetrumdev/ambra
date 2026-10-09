import { useEffect, useMemo, useState } from "react";
import { cachedArtistAlbums, cachedArtistProfile, loadArtistAlbums, loadArtistProfile, type ArtistProfile, type CatalogAlbum, type CatalogArtist } from "../api/server";
import { rememberArtistImage } from "../utils/artistImages";
import { libraryAlbums } from "../utils/librarySections";
import { artistBiography, artistReleaseSections } from "../utils/artistPage";
import { entityKey, entityProvider, tracksForEntity } from "../utils/browse";
import { musicProviderName } from "../utils/musicProviderName";
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
  const initialReleases = cachedArtistAlbums(artist);
  const [profile, setProfile] = useState<ArtistProfile | undefined>(initialProfile);
  const [albums, setAlbums] = useState<CatalogAlbum[]>(cached?.albumsLoaded ? cached.albums ?? [] : initialReleases?.albums ?? []);
  const [albumsLoaded, setAlbumsLoaded] = useState(cached?.albumsLoaded || !!initialReleases);
  const [nextOffset, setNextOffset] = useState<number | null>(cached?.albumsLoaded ? cached.nextOffset ?? null : initialReleases?.nextOffset ?? null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(artist.provider !== "local" && !initialProfile);
  const [releasesLoading, setReleasesLoading] = useState(artist.provider !== "local" && !albumsLoaded);
  const [profileAttempt, setProfileAttempt] = useState(0);
  const [releaseRequest, setReleaseRequest] = useState({ offset: 0, attempt: 0 });
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
    if (artist.provider === "local" || (albumsLoaded && releaseRequest.offset === 0 && releaseRequest.attempt === 0)) return;
    const controller = new AbortController(); setReleasesLoading(true); setReleaseError(null);
    void loadArtistAlbums(artist, releaseRequest.offset, controller.signal, releaseRequest.attempt > 0).then(page => {
      if (controller.signal.aborted) return;
      setAlbums(current => [...new Map([...current, ...page.albums].map(album => [album.id, album])).values()]);
      setNextOffset(page.nextOffset); setAlbumsLoaded(true);
    }).catch(reason => { if (!controller.signal.aborted) setReleaseError(String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setReleasesLoading(false); });
    return () => controller.abort();
  }, [artist.id, artist.provider, releaseRequest]);
  useEffect(() => {
    props.cache.set(key, { profile, albums, albumsLoaded, nextOffset, expandedPopular, expandedBiography });
  }, [key, profile, albums, albumsLoaded, nextOffset, expandedPopular, expandedBiography, props.cache]);
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
  const biography = useMemo(() => artistBiography(profile?.biography), [profile?.biography]);
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
    headerContent={<p className="entityByline">Artist · {musicProviderName(artist.provider)}</p>}
    playbackActions={<button type="button" className="libraryShuffleBtn" disabled={!playable.length} onClick={() => props.onAction("queue", playable)}><img src="/addToQueue.svg" alt="" /><span>ADD TO QUEUE</span></button>}
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
      {releaseError && <p className="artistStatus" role="alert">{releaseError} <button type="button" className="entityLink" onClick={() => setReleaseRequest(current => ({ ...current, attempt: current.attempt + 1 }))}>Retry</button></p>}
      {nextOffset !== null && <button type="button" className="artistTextAction" disabled={releasesLoading} onClick={() => setReleaseRequest(current => ({ offset: nextOffset, attempt: current.attempt + 1 }))}>More releases</button>}
      {!!saved.length && <section><h2 className="entitySectionTitle">Saved songs</h2>{trackList(saved)}</section>}
      {!!biography.length && <section className="artistAbout"><h2 className="entitySectionTitle">About</h2><div className="artistBiography" data-expanded={expandedBiography}>{biography.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
        <button type="button" className="artistTextAction" onClick={() => setExpandedBiography(value => !value)}>{expandedBiography ? "Show less" : "Read more"}</button>
        {profile?.biographySource && <p className="artistBiographySource">{profile.biographySource}</p>}
      </section>}
    </>}
  />;
}
