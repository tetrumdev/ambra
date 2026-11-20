import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { ListeningEntry } from "../hooks/useListeningHistory";
import { useRangeSelection } from "../hooks/useRangeSelection";
import { isTrackAvailable, useServiceAvailability } from "../hooks/useServiceAvailability";
import { useTrackReorder } from "../hooks/useTrackReorder";
import { useVirtualWindow } from "../hooks/useVirtualWindow";
import type { QueueEntry, QueueHistoryEntry, QueueId, Track } from "../types/music";
import { albumForTrack, type BrowseEntity } from "../utils/browse";
import { queueEntryKey } from "../utils/queueNavigation";
import { formatTotalDuration } from "../utils/totalDuration";
import type { DropPosition } from "../utils/trackCollectionOrder";
import { showTrackCredits } from "../utils/trackCredits";
import { isKeyboardMenuClick, MENU_WIDTH } from "../utils/trackMenu";
import { ArtistLinks } from "./ArtistLinks";
import { DropdownChevron } from "./DropdownChevron";
import { TrackArtwork } from "./TrackArtwork";
import { TrackCollectionMenu, type PlaylistMenuOptions } from "./TrackCollectionMenu";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { VirtualSpacer } from "./VirtualSpacer";
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
  history: QueueHistoryEntry[];
  onJumpTo: (id: QueueId) => void;
  onReplayHistory: (historyId: string) => void;
  onRemove: (ids: QueueId[]) => void;
  onRemoveHistory: (historyIds: string[]) => void;
  onReorder: (ids: QueueId[]) => void;
  recent: ListeningEntry[];
  recentError: string | null;
  onRecentAction: (action: "standalone" | "next" | "queue", track: Track) => void;
  onOpenEntity: (entity: BrowseEntity) => void;
  playlistOptions: PlaylistMenuOptions;
  savedTrackIds: ReadonlySet<string>;
  addToLibrary: (track: Track) => void;
};

type PlaybackSidebarProps = SidebarTracksProps & {
  view: PlaybackSidebarView;
  /** Over the player, the panel floats as glass and leaves the lyrics to the stage. */
  floating: boolean;
  preferredWidth: RefObject<number | null>;
  onChangeView: (view: PlaybackSidebarView) => void;
  onClose: () => void;
  lyrics: ReactNode;
};

export function PlaybackSidebar({
  view: chosenView, floating, preferredWidth, onChangeView, onClose, lyrics, ...tracks
}: PlaybackSidebarProps) {
  const shownViews = floating ? views.filter(({ id }) => id !== "lyrics") : views;
  const view = floating && chosenView === "lyrics" ? "queue" : chosenView;
  return (
    <aside className="playbackSidebar" id="playbackSidebar" aria-label="Playback sidebar"
      data-floating={floating || undefined}
      onKeyDown={event => { if (event.key === " " && event.target instanceof HTMLButtonElement) event.stopPropagation(); }}>
      <PlaybackSidebarResize preferredWidth={preferredWidth} />
      <header className="playbackSidebarHeader">
        <div className="playbackSidebarTabs" role="tablist" aria-label="Playback sidebar view">
          {shownViews.map(({ id, label }) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} aria-controls="playbackSidebarPanel"
              onClick={() => onChangeView(id)}>{label}</button>
          ))}
        </div>
        <button type="button" className="xContainer playbackSidebarClose" aria-label="Close playback sidebar"
          onClick={onClose}>
          <img className="closeBtn" src="/x.svg" alt="" />
        </button>
      </header>
      <div className="playbackSidebarPanel" id="playbackSidebarPanel" role="tabpanel">
        {view === "lyrics" ? lyrics : <SidebarTracks key={view} view={view} {...tracks} />}
      </div>
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

const ROW_HEIGHT = 56;
const VIRTUALIZE_AFTER_ROWS = 120;

type SidebarEntry = { id: string; track: Track; queueId?: QueueId; historyId?: string; current?: boolean };
type SidebarMenu =
  | { kind: "playback" | "collection"; id: string; anchor: HTMLElement; x: number; y: number; flipY: number; keyboard: boolean }
  | { kind: "selection"; anchor: HTMLButtonElement; x: number; y: number; flipY: number };
type RowAction = "play" | "playback" | "collection" | "select";
type EntryAction = (action: RowAction, event: MouseEvent<HTMLElement>, entry: SidebarEntry) => void;

function formatDuration(durationSeconds: number) {
  const seconds = Math.max(0, Math.floor(durationSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function SidebarTracks({
  view, currentTrack, isPlaying, onTogglePlayback, upcoming: upcomingEntries, history: historyEntries,
  onJumpTo, onReplayHistory, onRemove, onRemoveHistory, onReorder,
  recent, recentError, onRecentAction, onOpenEntity, playlistOptions, savedTrackIds, addToLibrary,
}: SidebarTracksProps & { view: "queue" | "recent" }) {
  const queueView = view === "queue";
  const connected = useServiceAvailability();
  const scroller = useRef<HTMLDivElement>(null);
  const nowPlayingRef = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<SidebarMenu | null>(null);
  // Played songs start folded into one line above now playing, so the queue opens on what's playing.
  const [historyOpen, setHistoryOpen] = useState(false);

  const current = useMemo<SidebarEntry | undefined>(() => queueView && currentTrack
    ? { id: `current:${currentTrack.globalId}`, track: currentTrack, current: true }
    : undefined, [queueView, currentTrack]);
  const upcoming = useMemo<SidebarEntry[]>(() => queueView
    ? upcomingEntries.map(entry => ({ id: queueEntryKey(entry), track: entry.track, queueId: entry.queueId }))
    : [...recent].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).map(({ track }) => ({ id: `recent:${track.globalId}`, track })),
  [queueView, upcomingEntries, recent]);
  const history = useMemo<SidebarEntry[]>(() => queueView
    ? historyEntries.map(entry => ({ id: `history:${entry.historyId}`, track: entry.track, historyId: entry.historyId }))
    : [], [queueView, historyEntries]);
  const shownHistory = historyOpen ? history : [];
  const allEntries = useMemo(() => [...shownHistory, ...(current ? [current] : []), ...upcoming], [shownHistory, current, upcoming]);

  const upcomingIds = useMemo(() => upcoming.map(entry => entry.id), [upcoming]);
  const selectableIds = useMemo(() => [...shownHistory, ...upcoming]
    .filter(({ track }) => isTrackAvailable(track, connected)).map(({ id }) => id), [shownHistory, upcoming, connected]);
  const selection = useRangeSelection(selectableIds);
  const selectionOrder = useMemo(() => selectableIds.join("|"), [selectableIds]);
  useEffect(() => { selection.clear(); }, [selectionOrder, selection.clear]);

  const menuId = menu && "id" in menu ? menu.id : undefined;
  const menuEntry = menuId === undefined ? undefined : allEntries.find(entry => entry.id === menuId);
  const menuAvailable = menuEntry !== undefined && isTrackAvailable(menuEntry.track, connected);
  const menuRemovable = menuEntry?.queueId !== undefined || menuEntry?.historyId !== undefined;
  const menuCanOpen = menuAvailable || (menu?.kind === "collection" && menuRemovable);
  useEffect(() => { if (menuId && !menuCanOpen) setMenu(null); }, [menuId, menuCanOpen]);
  const selected = selection.isSelecting ? allEntries.filter(entry => selection.selectedIds.has(entry.id)) : [];

  function closeMenu() {
    setMenu(null);
    if (menu?.anchor.isConnected) menu.anchor.focus({ preventScroll: true });
  }

  function reorder(orderedIds: string[]) {
    if (orderedIds.every((id, index) => id === upcomingIds[index])) return;
    const queueIds = new Map(upcoming.map(entry => [entry.id, entry.queueId]));
    const ordered = orderedIds.map(id => queueIds.get(id));
    if (ordered.every(id => id !== undefined)) onReorder(ordered);
  }
  const moveToFront = (entry: SidebarEntry) => reorder([entry.id, ...upcomingIds.filter(id => id !== entry.id)]);

  const { draggedTrackId, dropTarget, suppressClick, onPointerDown } = useTrackReorder(
    upcomingIds, queueView ? reorder : undefined, () => setMenu(null), scroller,
  );

  function removeEntries(entries: SidebarEntry[]) {
    const queueIds = entries.flatMap(({ queueId }) => queueId === undefined ? [] : [queueId]);
    const historyIds = entries.flatMap(({ historyId }) => historyId === undefined ? [] : [historyId]);
    if (queueIds.length) onRemove(queueIds);
    if (historyIds.length) onRemoveHistory(historyIds);
    selection.clear();
    setMenu(null);
  }

  function playEntry(entry: SidebarEntry) {
    if (entry.current) onTogglePlayback();
    else if (entry.queueId !== undefined) onJumpTo(entry.queueId);
    else if (entry.historyId !== undefined) onReplayHistory(entry.historyId);
    else onRecentAction("standalone", entry.track);
  }

  function recentAction(action: "standalone" | "next" | "queue") {
    if (!menuEntry) return;
    closeMenu();
    onRecentAction(action, menuEntry.track);
  }

  // Stable, so the playback clock and menus re-render only the rows they change.
  const actions = useRef<EntryAction>(() => {});
  actions.current = (action, event, entry) => {
    const available = isTrackAvailable(entry.track, connected);
    // A click that ended a drag never opens or plays anything.
    if (!entry.current && suppressClick.current && event.detail !== 0) return;
    if (action === "select" || (selection.isSelecting && !entry.current && action !== "collection")) {
      const index = selectableIds.indexOf(entry.id);
      if (index < 0) return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      selection.toggle(index, event.shiftKey);
      return;
    }
    if (selection.isSelecting && action === "collection" && !entry.current) {
      actions.current("select", event, entry);
      return;
    }
    event.stopPropagation();
    if (action === "play") {
      if (available || entry.current) {
        setMenu(null);
        playEntry(entry);
      }
      return;
    }
    if (action === "playback" && (!available || entry.current)) return;
    if (action === "collection" && !available && entry.queueId === undefined && entry.historyId === undefined) return;
    const anchor = event.currentTarget;
    const rect = anchor.getBoundingClientRect();
    const keyboard = isKeyboardMenuClick(event);
    setMenu(action === "collection"
      ? { kind: action, id: entry.id, anchor, x: rect.right - MENU_WIDTH, y: rect.bottom + 4, flipY: rect.top - 4, keyboard }
      : { kind: action, id: entry.id, anchor, x: keyboard ? rect.left : event.clientX, y: keyboard ? rect.bottom : event.clientY,
        flipY: keyboard ? rect.top : event.clientY, keyboard });
  };
  const onAction = useCallback<EntryAction>((action, event, entry) => actions.current(action, event, entry), []);

  // Unfolding shows the latest plays right above now playing, which moves down at most to the
  // middle of the panel; older plays are further up.
  const nowPlayingTopBeforeOpen = useRef<number | null>(null);
  function toggleHistory() {
    const open = !historyOpen;
    const panel = scroller.current;
    const anchor = nowPlayingRef.current;
    nowPlayingTopBeforeOpen.current = open && panel && anchor
      ? anchor.getBoundingClientRect().top - panel.getBoundingClientRect().top
      : null;
    setHistoryOpen(open);
  }
  useLayoutEffect(() => {
    const before = nowPlayingTopBeforeOpen.current;
    nowPlayingTopBeforeOpen.current = null;
    const panel = scroller.current;
    const anchor = nowPlayingRef.current;
    if (before === null || !panel || !anchor) return;
    const grown = anchor.getBoundingClientRect().top - panel.getBoundingClientRect().top - before;
    const shift = Math.min(grown, Math.max(0, panel.clientHeight / 2 - before));
    panel.scrollTop += grown - shift;
  }, [historyOpen]);
  // Folding history away with nothing left to fold.
  useEffect(() => { if (!history.length) setHistoryOpen(false); }, [history.length]);

  const rowProps = {
    selecting: selection.isSelecting, selectedIds: selection.selectedIds, menuId, menuKind: menu?.kind,
    onAction, onOpenEntity, draggedId: draggedTrackId, dropTarget,
  };
  const upcomingDuration = upcoming.reduce((total, entry) => total + entry.track.durationSeconds, 0);

  return (
    <>
      {menu?.kind === "playback" && menuEntry && menuAvailable && (menuEntry.queueId !== undefined || menuEntry.historyId !== undefined
        ? <TrackCollectionMenu trackId={menuEntry.track.globalId} xPos={menu.x} yPos={menu.y} flipY={menu.flipY} onClose={closeMenu}
            actions={menuEntry.queueId !== undefined ? [
              { label: "Play from Here", icon: "/skip.svg", onSelect: () => playEntry(menuEntry) },
              { label: "Move to Front", icon: "/play-next.svg", disabled: upcoming[0] === menuEntry, onSelect: () => moveToFront(menuEntry) },
              { label: "Remove from Queue", icon: "/delete.svg", onSelect: () => removeEntries([menuEntry]) },
            ] : [
              { label: "Play Again", icon: "/skip.svg", onSelect: () => playEntry(menuEntry) },
              { label: "Remove from History", icon: "/delete.svg", onSelect: () => removeEntries([menuEntry]) },
            ]} />
        : <TrackPlaybackMenu trackId={menuEntry.track.globalId} xPos={menu.x} yPos={menu.y} onClose={() => setMenu(null)}
            openedWithKeyboard={menu.keyboard} playStandalone={() => recentAction("standalone")}
            playNext={() => recentAction("next")} addToQueue={() => recentAction("queue")} />)}
      {menu?.kind === "collection" && menuEntry && menuCanOpen && <TrackCollectionMenu trackId={menuEntry.track.globalId}
        xPos={menu.x} yPos={menu.y} flipY={menu.flipY} onClose={closeMenu} playlistOptions={menuAvailable ? playlistOptions : undefined}
        actions={menuAvailable ? [
          ...(menuEntry.track.provider !== "local" && !savedTrackIds.has(menuEntry.track.globalId)
            ? [{ label: "Add to Library", icon: "/add.svg", onSelect: () => addToLibrary(menuEntry.track) }] : []),
          { label: "Go to Album", icon: "/album.svg", onSelect: () => onOpenEntity({ kind: "album", album: albumForTrack(menuEntry.track) }) },
          { label: "Credits", icon: "/credits.svg", onSelect: () => showTrackCredits(menuEntry.track) },
          ...(menuEntry.current ? [] : [{
            label: "Select Songs", icon: "/no-select.svg", onSelect: () => selection.toggle(selectableIds.indexOf(menuEntry.id), false),
          }]),
        ] : [
          ...(menuEntry.queueId !== undefined ? [{ label: "Move to Front", icon: "/play-next.svg", whenUnavailable: true,
            disabled: upcoming[0] === menuEntry, onSelect: () => moveToFront(menuEntry) }] : []),
          { label: menuEntry.historyId !== undefined ? "Remove from History" : "Remove from Queue", icon: "/delete.svg",
            whenUnavailable: true, onSelect: () => removeEntries([menuEntry]) },
        ]}
      />}
      {menu?.kind === "selection" && selected.length > 0 && <TrackCollectionMenu trackId="" actions={[]}
        tracks={[...new Map(selected.map(({ track }) => [track.globalId, track])).values()]}
        startWithPlaylistPicker playlistOptions={playlistOptions} xPos={menu.x} yPos={menu.y} flipY={menu.flipY} onClose={closeMenu} />}

      {selection.isSelecting && <div className="playbackSidebarSelection" role="group" aria-label="Selected songs">
        <span className="playbackSidebarSelectionCount" aria-live="polite">{selected.length} selected</span>
        {queueView && <button type="button" className="playbackSidebarPill" data-tone="danger" disabled={!selected.length}
          onClick={() => removeEntries(selected)}>Remove</button>}
        <button type="button" className="playbackSidebarPill" disabled={!selected.length} onClick={event => {
          const anchor = event.currentTarget;
          const rect = anchor.getBoundingClientRect();
          setMenu({ kind: "selection", anchor, x: Math.max(8, rect.right - MENU_WIDTH), y: rect.bottom + 4, flipY: rect.top - 4 });
        }}>Add to Playlist</button>
        <button type="button" className="playbackSidebarPill" onClick={selection.clear}>Cancel</button>
      </div>}

      <div className="playbackSidebarScroll" ref={scroller} data-selecting={selection.isSelecting || undefined}>
        {queueView ? <>
          {history.length > 0 && <div className="playbackSidebarHistoryBar">
            <button type="button" className="playbackSidebarHistoryToggle" aria-expanded={historyOpen}
              aria-controls="playbackSidebarHistory" onClick={toggleHistory}>
              <DropdownChevron />
              <span>Played</span>
              <span className="playbackSidebarCount">{history.length}</span>
            </button>
            {historyOpen && <button type="button" className="playbackSidebarTextButton"
              onClick={() => removeEntries(history)}>Clear</button>}
          </div>}
          {historyOpen && <SidebarRows id="playbackSidebarHistory" label="Played songs" entries={history} {...rowProps} />}

          <section className="playbackSidebarSection" ref={nowPlayingRef} aria-labelledby="playbackSidebarNowPlaying">
            <h2 className="playbackSidebarHeading" id="playbackSidebarNowPlaying">Now Playing</h2>
            {current
              ? <NowPlayingCard entry={current} isPlaying={isPlaying} menuOpen={menuId === current.id}
                  onAction={onAction} onOpenEntity={onOpenEntity} />
              : <p className="playbackSidebarMessage">Nothing is playing.</p>}
          </section>

          <section className="playbackSidebarSection" aria-labelledby="playbackSidebarUpNext">
            <div className="playbackSidebarSectionHeader">
              <h2 className="playbackSidebarHeading" id="playbackSidebarUpNext">Up Next</h2>
              {upcoming.length > 0 && <>
                <span className="playbackSidebarMeta">
                  {upcoming.length.toLocaleString()} {upcoming.length === 1 ? "song" : "songs"} · {formatTotalDuration(upcomingDuration)}
                </span>
                <button type="button" className="playbackSidebarTextButton" onClick={() => removeEntries(upcoming)}>Clear</button>
              </>}
            </div>
            {upcoming.length > 0
              ? <SidebarRows label="Upcoming songs" entries={upcoming} onPointerDown={onPointerDown} {...rowProps} />
              : <p className="playbackSidebarMessage">Songs you queue show up here. Add some with “Play Next” or “Add to Queue”.</p>}
          </section>
        </> : <section className="playbackSidebarSection" aria-label="Recently played songs">
          {recentError && <p className="playbackSidebarMessage" role="alert">{recentError}</p>}
          {upcoming.length > 0
            ? <SidebarRows label="Recently played songs" entries={upcoming} {...rowProps} />
            : !recentError && <p className="playbackSidebarMessage">Play a song to start your listening history.</p>}
        </section>}
      </div>
    </>
  );
}

type RowsProps = {
  selecting: boolean;
  selectedIds: ReadonlySet<string>;
  menuId?: string;
  menuKind?: SidebarMenu["kind"];
  onAction: EntryAction;
  onOpenEntity: (entity: BrowseEntity) => void;
  draggedId: string | null;
  dropTarget: { trackId: string; position: DropPosition } | null;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>, index: number) => void;
};

function SidebarRows({ id, label, entries, selectedIds, menuId, draggedId, dropTarget, ...props }: RowsProps & {
  id?: string;
  label: string;
  entries: SidebarEntry[];
}) {
  const list = useRef<HTMLDivElement>(null);
  const virtual = useVirtualWindow({
    count: entries.length, enabled: entries.length > VIRTUALIZE_AFTER_ROWS, probeRef: list, probeIsContainer: true,
    fallback: { rowHeight: ROW_HEIGHT }, cacheKey: `playback-sidebar:${label}`, overscanRows: 10,
    pinnedIndex: draggedId ? entries.findIndex(entry => entry.id === draggedId) : null,
  });
  return (
    <div className="playbackSidebarRows" id={id} role="list" aria-label={label} ref={list}>
      {virtual.topSpace > 0 && <VirtualSpacer position="top" height={virtual.topSpace} />}
      {entries.slice(virtual.start, virtual.end).map((entry, offset) => <SidebarRow
        key={entry.id} entry={entry} index={virtual.start + offset} {...props}
        selected={selectedIds.has(entry.id)} menuOpen={menuId === entry.id} dragging={entry.id === draggedId}
        dropPosition={dropTarget?.trackId === entry.id ? dropTarget.position : undefined} />)}
      {virtual.bottomSpace > 0 && <VirtualSpacer position="bottom" height={virtual.bottomSpace} />}
    </div>
  );
}

/** Play or pause over a song's cover; shown on hover, and always for the song that is playing. */
function ArtworkButton({ track, playing, label, disabled, onClick }: {
  track: Track;
  playing: boolean;
  label: string;
  disabled?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="playbackSidebarArtwork">
      <TrackArtwork track={track} alt="" className="playbackSidebarCover" draggable={false} />
      <button type="button" className="playbackSidebarArtworkButton" aria-label={label} disabled={disabled} onClick={onClick}>
        <img src={playing ? "/pause.svg" : "/play.svg"} alt="" />
      </button>
    </div>
  );
}

const SidebarRow = memo(function SidebarRow({
  entry, index, selecting: selectionActive, selected, menuOpen, menuKind, onAction, onOpenEntity,
  onPointerDown, dragging, dropPosition,
}: Omit<RowsProps, "selectedIds" | "menuId" | "draggedId" | "dropTarget"> & {
  entry: SidebarEntry;
  index: number;
  selected: boolean;
  menuOpen: boolean;
  dragging: boolean;
  dropPosition?: DropPosition;
}) {
  const connected = useServiceAvailability();
  const { track } = entry;
  const available = isTrackAvailable(track, connected);
  const selecting = selectionActive && available;
  const collectionOpen = menuOpen && menuKind === "collection";
  const played = entry.historyId !== undefined;
  return (
    <div className="playbackSidebarRow" role="listitem" data-track-id={entry.id} data-virtual-item=""
      data-unavailable={!available || undefined} data-played={played || undefined}
      data-selecting={selecting || undefined} data-selected={selected || undefined}
      data-menu-open={menuOpen || undefined} data-reorderable={(onPointerDown && available) || undefined}
      data-dragging={dragging || undefined} data-drop-position={dropPosition}
      onPointerDown={onPointerDown && available ? event => onPointerDown(event, index) : undefined}
      onClickCapture={event => {
        if (selecting || ((event.shiftKey || event.metaKey || event.ctrlKey) && available)) onAction("select", event, entry);
      }}
      onClick={event => onAction("playback", event, entry)}
      onContextMenu={event => onAction("select", event, entry)}
      onDragStart={event => event.preventDefault()} draggable={false}>
      <ArtworkButton track={track} playing={false} disabled={!available}
        label={`${played ? "Play again" : entry.queueId !== undefined ? "Play from" : "Play"} ${track.name}`}
        onClick={event => onAction("play", event, entry)} />
      <div className="playbackSidebarRowText" inert={!available}>
        <button type="button" className="playbackSidebarRowTitle" data-playback-menu-trigger
          aria-label={`Playback options for ${track.name}`} onClick={event => onAction("playback", event, entry)}>
          {track.name}
        </button>
        <span className="playbackSidebarRowArtists">
          <ArtistLinks track={track} onOpenEntity={onOpenEntity} />
        </span>
      </div>
      <div className="playbackSidebarRowEnd">
        <span className="playbackSidebarDuration" aria-hidden={selecting || undefined}>{formatDuration(track.durationSeconds)}</span>
        <button type="button" className="playbackSidebarMenuButton"
          disabled={!available && entry.queueId === undefined && entry.historyId === undefined}
          aria-label={`${selecting ? selected ? "Deselect" : "Select" : "More options for"} ${track.name}`}
          aria-pressed={selecting ? selected : undefined}
          aria-haspopup={selecting ? undefined : "menu"}
          aria-expanded={selecting ? undefined : collectionOpen}
          data-collection-menu-trigger data-collection-menu-open={collectionOpen || undefined}
          onClick={event => onAction("collection", event, entry)}>
          <img src={selecting ? selected ? "/select.svg" : "/no-select.svg" : "/menu.svg"} alt="" />
        </button>
      </div>
    </div>
  );
});

function NowPlayingCard({ entry, isPlaying, menuOpen, onAction, onOpenEntity }: {
  entry: SidebarEntry;
  isPlaying: boolean;
  menuOpen: boolean;
  onAction: EntryAction;
  onOpenEntity: (entity: BrowseEntity) => void;
}) {
  const { track } = entry;
  return (
    <div className="playbackSidebarNowPlaying" data-playing={isPlaying || undefined} data-menu-open={menuOpen || undefined}>
      <ArtworkButton track={track} playing={isPlaying} label={`${isPlaying ? "Pause" : "Play"} ${track.name}`}
        onClick={event => onAction("play", event, entry)} />
      <div className="playbackSidebarNowPlayingText">
        <span className="playbackSidebarNowPlayingTitle" title={track.name}>{track.name}</span>
        <span className="playbackSidebarRowArtists"><ArtistLinks track={track} onOpenEntity={onOpenEntity} /></span>
        <span className="playbackSidebarRowArtists">
          <button type="button" className="entityLink" onClick={() => onOpenEntity({ kind: "album", album: albumForTrack(track) })}>
            {track.album}
          </button>
        </span>
      </div>
      <button type="button" className="playbackSidebarMenuButton" aria-label={`More options for ${track.name}`}
        aria-haspopup="menu" aria-expanded={menuOpen} data-collection-menu-open={menuOpen || undefined}
        onClick={event => onAction("collection", event, entry)}>
        <img src="/menu.svg" alt="" />
      </button>
    </div>
  );
}
