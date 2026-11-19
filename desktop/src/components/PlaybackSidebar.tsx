import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { ListeningEntry } from "../hooks/useListeningHistory";
import { useRangeSelection } from "../hooks/useRangeSelection";
import { isTrackAvailable, useServiceAvailability } from "../hooks/useServiceAvailability";
import { useTrackReorder } from "../hooks/useTrackReorder";
import { useVirtualWindow } from "../hooks/useVirtualWindow";
import type { QueueEntry, QueueId, Track } from "../types/music";
import { queueEntryKey } from "../utils/queueNavigation";
import { trackArtistNames } from "../utils/trackArtists";
import { showTrackCredits } from "../utils/trackCredits";
import { isKeyboardMenuClick, MENU_WIDTH } from "../utils/trackMenu";
import { TrackArtwork } from "./TrackArtwork";
import { TrackCollectionMenu, type PlaylistMenuOptions } from "./TrackCollectionMenu";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { VirtualSpacer } from "./VirtualSpacer";
import "./LibraryView.css";
import "./PlaybackSidebar.css";

const views = [
  { id: "queue", label: "Queue" },
  { id: "lyrics", label: "Lyrics" },
  { id: "recent", label: "Recently played" },
] as const;

export type PlaybackSidebarView = typeof views[number]["id"];

type SidebarTracksProps = {
  currentTrack: Track | undefined;
  isPlaying: boolean;
  onTogglePlayback: () => void;
  upcoming: QueueEntry[];
  onJumpTo: (id: QueueId) => void;
  onRemove: (ids: QueueId[]) => void;
  onReorder: (ids: QueueId[]) => void;
  onOpenFullQueue: () => void;
  recent: ListeningEntry[];
  recentError: string | null;
  onRecentAction: (action: "standalone" | "next" | "queue", track: Track) => void;
  playlistOptions: PlaylistMenuOptions;
  savedTrackIds: ReadonlySet<string>;
  addToLibrary: (track: Track) => void;
};

type PlaybackSidebarProps = SidebarTracksProps & {
  view: PlaybackSidebarView;
  preferredWidth: RefObject<number | null>;
  onChangeView: (view: PlaybackSidebarView) => void;
  onClose: () => void;
  lyrics: ReactNode;
};

export function PlaybackSidebar({
  view, preferredWidth, onChangeView, onClose, lyrics, ...tracks
}: PlaybackSidebarProps) {
  return (
    <aside className="playbackSidebar" id="playbackSidebar" aria-label="Playback sidebar"
      onKeyDown={event => { if (event.key === " " && event.target instanceof HTMLButtonElement) event.stopPropagation(); }}>
      <PlaybackSidebarResize preferredWidth={preferredWidth} />
      <header className="playbackSidebarHeader">
        <div className="playbackSidebarViews" role="group" aria-label="Playback sidebar view">
          {views.map(({ id, label }) => (
            <button key={id} type="button" aria-pressed={view === id} onClick={() => onChangeView(id)}>{label}</button>
          ))}
        </div>
        <button type="button" className="xContainer playbackSidebarClose" aria-label="Close playback sidebar" onClick={onClose}>
          <img className="closeBtn" src="/x.svg" alt="" />
        </button>
      </header>
      {view === "lyrics" ? lyrics : <SidebarTracks key={view} view={view} {...tracks} />}
    </aside>
  );
}

const MIN_SIDEBAR_WIDTH = 320;
const MAX_SIDEBAR_WIDTH = 520;
const MIN_PAGE_WIDTH = 500;
const SIDEBAR_WIDTH_PROPERTY = "--playback-sidebar-width";

function PlaybackSidebarResize({ preferredWidth }: { preferredWidth: RefObject<number | null> }) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [requestedWidth, setRequestedWidth] = useState(preferredWidth.current);
  const min = Math.min(MIN_SIDEBAR_WIDTH, windowWidth);
  const max = Math.min(MAX_SIDEBAR_WIDTH, Math.max(min, windowWidth - MIN_PAGE_WIDTH));
  const clampWidth = (width: number) => Math.min(max, Math.max(min, Math.round(width)));
  const width = clampWidth(requestedWidth ?? Math.min(380, windowWidth * 0.28));

  useLayoutEffect(() => {
    const syncWindowWidth = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", syncWindowWidth);
    return () => window.removeEventListener("resize", syncWindowWidth);
  }, []);
  useLayoutEffect(() => {
    // The panel, page, scrollbar and page filter all use the same width.
    const viewport = handle.current?.closest<HTMLElement>(".appViewport");
    viewport?.style.setProperty(SIDEBAR_WIDTH_PROPERTY, `${width}px`);
    return () => { viewport?.style.removeProperty(SIDEBAR_WIDTH_PROPERTY); };
  }, [width]);

  function resize(next: number) {
    preferredWidth.current = clampWidth(next);
    setRequestedWidth(preferredWidth.current);
  }

  return (
    <div className="playbackSidebarResize" ref={handle} role="separator" tabIndex={0}
      aria-label="Playback sidebar width" aria-controls="playbackSidebar" aria-orientation="vertical"
      aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} aria-valuetext={`${width} pixels`}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        const target = event.currentTarget;
        drag.current = { pointerId: event.pointerId, x: event.clientX, width };
        target.setPointerCapture(event.pointerId);
        target.setAttribute("data-resizing", "");
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (start?.pointerId === event.pointerId) resize(start.width + start.x - event.clientX);
      }}
      onLostPointerCapture={event => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        event.currentTarget.removeAttribute("data-resizing");
      }}
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const step = event.shiftKey ? 40 : 10;
        switch (event.key) {
          case "ArrowLeft": resize(width + step); break;
          case "ArrowRight": resize(width - step); break;
          case "Home": resize(min); break;
          case "End": resize(max); break;
          default: return;
        }
        event.preventDefault();
        event.stopPropagation();
      }}
    />
  );
}

const TRACK_ROW_HEIGHT = 60;

type SidebarEntry = { id: string; track: Track; queueId?: QueueId };
type SidebarMenu =
  | { kind: "playback" | "collection"; id: string; anchor: HTMLElement; x: number; y: number; flipY: number; keyboard: boolean }
  | { kind: "selection"; anchor: HTMLButtonElement; x: number; y: number; flipY: number };

function SidebarTracks({
  view, currentTrack, isPlaying, onTogglePlayback, upcoming, onJumpTo, onRemove, onReorder, onOpenFullQueue,
  recent, recentError, onRecentAction, playlistOptions, savedTrackIds, addToLibrary,
}: SidebarTracksProps & { view: "queue" | "recent" }) {
  const queueView = view === "queue";
  const connected = useServiceAvailability();
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<SidebarMenu | null>(null);
  const current: SidebarEntry | undefined = queueView && currentTrack
    ? { id: `current:${currentTrack.globalId}`, track: currentTrack }
    : undefined;
  const entries = useMemo<SidebarEntry[]>(() => queueView
    ? upcoming.map(entry => ({ id: queueEntryKey(entry), track: entry.track, queueId: entry.queueId }))
    : [...recent].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).map(({ track }) => ({ id: track.globalId, track })),
  [queueView, upcoming, recent]);
  const ids = useMemo(() => entries.map(entry => entry.id), [entries]);
  const selectableIds = useMemo(() => entries.filter(({ track }) => isTrackAvailable(track, connected)).map(({ id }) => id),
    [entries, connected]);
  const selection = useRangeSelection(selectableIds);
  const selectionOrder = useMemo(() => JSON.stringify(selectableIds), [selectableIds]);
  useEffect(() => { selection.clear(); }, [selectionOrder, selection.clear]);

  function closeMenu() {
    setMenu(null);
    if (menu?.anchor.isConnected) menu.anchor.focus({ preventScroll: true });
  }

  function reorder(orderedIds: string[]) {
    if (orderedIds.every((id, index) => id === ids[index])) return;
    const queueIds = new Map(upcoming.map(entry => [queueEntryKey(entry), entry.queueId]));
    const ordered = orderedIds.map(id => queueIds.get(id));
    if (ordered.every(id => id !== undefined)) onReorder(ordered);
  }

  const { draggedTrackId, dropTarget, suppressClick, onPointerDown } = useTrackReorder(
    ids, queueView ? reorder : undefined, () => setMenu(null), scroller,
  );
  const label = queueView ? "Upcoming tracks" : "Recently played tracks";
  const virtual = useVirtualWindow({
    count: entries.length, enabled: entries.length > 120, probeRef: list, probeIsContainer: true,
    fallback: { rowHeight: TRACK_ROW_HEIGHT }, cacheKey: `playback-sidebar:${label}`,
    pinnedIndex: draggedTrackId ? ids.indexOf(draggedTrackId) : null,
  });
  const menuId = menu && "id" in menu ? menu.id : undefined;
  const menuEntry = menuId === current?.id ? current : entries.find(entry => entry.id === menuId);
  const menuQueueId = menuEntry?.queueId;
  const menuAvailable = menuEntry && isTrackAvailable(menuEntry.track, connected);
  const menuCanOpen = menuAvailable || (menu?.kind === "collection" && menuQueueId !== undefined);
  const selected = selection.isSelecting ? entries.filter(entry => selection.selectedIds.has(entry.id)) : [];
  useEffect(() => { if (menuId && !menuCanOpen) setMenu(null); }, [menuId, menuCanOpen]);

  function selectEntry(event: MouseEvent, entry: SidebarEntry) {
    const index = selectableIds.indexOf(entry.id);
    if (index < 0 || (suppressClick.current && event.type === "click" && event.detail !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    setMenu(null);
    selection.toggle(index, event.shiftKey);
  }

  function openMenu(event: MouseEvent<HTMLElement>, kind: "playback" | "collection", id: string) {
    if (id !== current?.id && suppressClick.current && event.detail !== 0) return;
    event.stopPropagation();
    const anchor = event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    const keyboard = isKeyboardMenuClick(event);
    setMenu(kind === "collection"
      ? { kind, id, anchor, x: rect.right - MENU_WIDTH, y: rect.bottom + 4, flipY: rect.top - 4, keyboard }
      : { kind, id, anchor, x: keyboard ? rect.left : event.clientX, y: keyboard ? rect.bottom : event.clientY,
        flipY: keyboard ? rect.top : event.clientY, keyboard });
  }

  function playEntry(entry: SidebarEntry) {
    if (entry.queueId !== undefined) onJumpTo(entry.queueId);
    else onRecentAction("standalone", entry.track);
  }

  function recentAction(action: "standalone" | "next" | "queue") {
    if (!menuEntry) return;
    closeMenu();
    onRecentAction(action, menuEntry.track);
  }

  function renderRow(entry: SidebarEntry, index?: number) {
    const { id, track } = entry;
    const currentRow = index === undefined;
    const available = isTrackAvailable(track, connected);
    const pausing = currentRow && isPlaying;
    const canPlay = available || pausing;
    const selecting = !currentRow && available && selection.isSelecting;
    const isSelected = selection.selectedIds.has(id);
    const collectionOpen = menuId === id && menu?.kind === "collection";
    const trackText = <>
      <span className="trackTitleText" title={track.name}>{track.name}</span>
      <small>{trackArtistNames(track)}</small>
    </>;
    return (
      <div key={id} className="libraryItem playbackSidebarRow" role={currentRow ? undefined : "listitem"}
        data-virtual-item={currentRow ? undefined : ""} data-track-id={id}
        aria-current={currentRow || undefined} data-unavailable={!canPlay || undefined}
        data-selecting={selecting || undefined} data-selected={isSelected || undefined}
        data-menu-open={menuId === id || undefined} data-reorderable={(queueView && !currentRow) || undefined}
        data-dragging={draggedTrackId === id || undefined}
        data-drop-position={dropTarget?.trackId === id ? dropTarget.position : undefined}
        onPointerDown={queueView && index !== undefined ? event => onPointerDown(event, index) : undefined}
        onClickCapture={!currentRow ? event => {
          if (selecting || event.shiftKey || event.metaKey || event.ctrlKey) selectEntry(event, entry);
        } : undefined}
        onContextMenu={!currentRow ? event => selectEntry(event, entry) : undefined}
        onClick={!currentRow && available ? event => openMenu(event, "playback", id) : undefined}
        onDragStart={event => event.preventDefault()} draggable={false}>
        <div className="trackLeading" inert={!canPlay}>
          <button type="button" className="trackPlayButton" disabled={!canPlay}
            aria-label={`${pausing ? "Pause" : "Play"} ${track.name}`}
            onClick={event => {
              event.stopPropagation();
              if (!currentRow && suppressClick.current && event.detail !== 0) return;
              if (currentRow) onTogglePlayback();
              else playEntry(entry);
            }}>
            <img src={pausing ? "/pause.svg" : "/play.svg"} alt="" />
          </button>
          <div className="coverImgContainer"><TrackArtwork track={track} alt="" className="coverImg" draggable={false} /></div>
        </div>
        {currentRow
          ? <div className="trackName playbackSidebarTrackText">{trackText}</div>
          : <button type="button" className="trackName playbackSidebarTrackText" disabled={!available}
              aria-label={`Playback options for ${track.name}`} data-playback-menu-trigger
              onClick={event => openMenu(event, "playback", id)}>{trackText}</button>}
        <button type="button" className="trackCollectionMenuTrigger"
          disabled={!available && entry.queueId === undefined}
          aria-label={`${selecting ? isSelected ? "Deselect" : "Select" : "Library options for"} ${track.name}`}
          aria-pressed={selecting ? isSelected : undefined}
          aria-haspopup={selecting ? undefined : "menu"}
          aria-expanded={selecting ? undefined : collectionOpen}
          data-collection-menu-trigger data-collection-menu-open={collectionOpen || undefined}
          onClick={event => openMenu(event, "collection", id)}>
          <img src={selecting ? isSelected ? "/select.svg" : "/no-select.svg" : "/menu.svg"}
            alt="" className={selecting ? "selectionIndicator" : undefined} />
        </button>
      </div>
    );
  }

  return (
    <>
      {menu?.kind === "playback" && menuEntry && menuAvailable && (menuQueueId !== undefined
        ? <TrackCollectionMenu trackId={menuEntry.track.globalId} xPos={menu.x} yPos={menu.y} flipY={menu.flipY} onClose={closeMenu}
            actions={[
              { label: "Play from Here", icon: "/skip.svg", onSelect: () => playEntry(menuEntry) },
              { label: "Move to front", icon: "/play-next.svg", disabled: entries[0] === menuEntry,
                onSelect: () => reorder([menuEntry.id, ...ids.filter(id => id !== menuEntry.id)]) },
              { label: "Remove from queue", icon: "/delete.svg", onSelect: () => onRemove([menuQueueId]) },
            ]} />
        : <TrackPlaybackMenu trackId={menuEntry.track.globalId} xPos={menu.x} yPos={menu.y} onClose={() => setMenu(null)}
            openedWithKeyboard={menu.keyboard} playStandalone={() => recentAction("standalone")}
            playNext={() => recentAction("next")} addToQueue={() => recentAction("queue")} />)}
      {menu?.kind === "collection" && menuEntry && menuCanOpen && <TrackCollectionMenu trackId={menuEntry.track.globalId}
        xPos={menu.x} yPos={menu.y} flipY={menu.flipY} onClose={closeMenu} playlistOptions={menuAvailable ? playlistOptions : undefined}
        actions={menuAvailable ? [
          ...(menuEntry.track.provider !== "local" && !savedTrackIds.has(menuEntry.track.globalId)
            ? [{ label: "Add to Library", icon: "/add.svg", onSelect: () => addToLibrary(menuEntry.track) }] : []),
          { label: "Credits", icon: "/credits.svg", onSelect: () => showTrackCredits(menuEntry.track) },
          ...(menuEntry === current ? [] : [{
            label: "Select tracks", icon: "/no-select.svg", onSelect: () => selection.toggle(selectableIds.indexOf(menuEntry.id), false),
          }]),
        ] : menuQueueId !== undefined ? [
          { label: "Move to front", icon: "/play-next.svg", whenUnavailable: true, disabled: entries[0] === menuEntry,
            onSelect: () => reorder([menuEntry.id, ...ids.filter(id => id !== menuEntry.id)]) },
          { label: "Remove from queue", icon: "/delete.svg", whenUnavailable: true, onSelect: () => onRemove([menuQueueId]) },
        ] : []}
      />}
      {menu?.kind === "selection" && selected.length > 0 && <TrackCollectionMenu trackId="" actions={[]}
        tracks={[...new Map(selected.map(({ track }) => [track.globalId, track])).values()]}
        startWithPlaylistPicker playlistOptions={playlistOptions} xPos={menu.x} yPos={menu.y} flipY={menu.flipY} onClose={closeMenu} />}
      {selection.isSelecting && <div className="selectionActionMenu playbackSidebarSelection" role="group" aria-label="Selected tracks">
        {queueView && <button type="button" className="selectionRemoveAction" disabled={!selected.length} onClick={() => {
          onRemove(selected.flatMap(({ queueId }) => queueId === undefined ? [] : [queueId]));
          selection.clear();
        }}>Remove</button>}
        <button type="button" disabled={!selected.length} onClick={event => {
          const anchor = event.currentTarget;
          const rect = anchor.getBoundingClientRect();
          setMenu({ kind: "selection", anchor, x: rect.left, y: rect.bottom + 4, flipY: rect.top - 4 });
        }}>Add to Playlist</button>
        <button type="button" onClick={selection.clear}>Cancel</button>
      </div>}
      <div className="playbackSidebarScroll" ref={scroller}>
        {current && <section aria-labelledby="playbackSidebarNowPlaying">
          <h2 className="queueSectionTitle" id="playbackSidebarNowPlaying">Now playing</h2>
          {renderRow(current)}
        </section>}
        <section aria-labelledby={queueView ? "playbackSidebarUpNext" : undefined}>
          {queueView && <div className="playbackSidebarSectionHeader">
            <h2 className="queueSectionTitle" id="playbackSidebarUpNext">Up next</h2>
            <button className="queueTextButton playbackSidebarTextButton" type="button" onClick={onOpenFullQueue}>Full queue</button>
          </div>}
          {!queueView && recentError && <p className="playbackSidebarMessage" role="alert">{recentError}</p>}
          {entries.length > 0 ? <div role="list" aria-label={label} ref={list}>
            {virtual.topSpace > 0 && <VirtualSpacer position="top" height={virtual.topSpace} />}
            {entries.slice(virtual.start, virtual.end).map((entry, offset) => renderRow(entry, virtual.start + offset))}
            {virtual.bottomSpace > 0 && <VirtualSpacer position="bottom" height={virtual.bottomSpace} />}
          </div> : (queueView || !recentError) && <p className="playbackSidebarMessage">
            {queueView ? "Nothing up next." : "Play a song to start your listening history."}
          </p>}
        </section>
      </div>
    </>
  );
}
