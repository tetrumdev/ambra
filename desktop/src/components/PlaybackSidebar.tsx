import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
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
import {
  isEntityLink, isKeyboardMenuClick, MENU_WIDTH, SongContextMenu, playSongOnDoubleClick, songMenuPosition, suppressSongClick,
  pauseTrackAction, trackPlaybackActions,
} from "../utils/trackMenu";
import { ArtistLinks } from "./ArtistLinks";
import { TrackTitleLink } from "./TrackTitleLink";
import { DropdownChevron } from "../design-system/DropdownChevron";
import { TrackArtwork } from "./TrackArtwork";
import { TrackCollectionMenu, type PlaylistMenuOptions, type TrackCollectionAction } from "./TrackCollectionMenu";
import { TrackPlaybackMenu } from "./TrackPlaybackMenu";
import { VirtualSpacer } from "./VirtualSpacer";
import "./LibraryView.css";
import "./PlaybackSidebar.css";

const views = [
  { id: "queue", label: "Queue" },
  { id: "lyrics", label: "Lyrics" },
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
  preferredWidth: number | null;
  /** The width the user settled on, after a drag ends or a key resizes it. */
  onResize: (width: number) => void;
  onChangeView: (view: PlaybackSidebarView) => void;
  onClose: () => void;
  lyrics: ReactNode;
};

export function PlaybackSidebar({
  view: chosenView, floating, preferredWidth, onResize, onChangeView, onClose, lyrics, ...tracks
}: PlaybackSidebarProps) {
  const shownViews = floating ? views.filter(({ id }) => id !== "lyrics") : views;
  const view = floating && chosenView === "lyrics" ? "queue" : chosenView;
  return (
    <aside className="playbackSidebar" id="playbackSidebar" aria-label="Playback sidebar"
      data-floating={floating || undefined}
      onKeyDown={event => { if (event.key === " " && event.target instanceof HTMLButtonElement) event.stopPropagation(); }}>
      <PlaybackSidebarResize preferredWidth={preferredWidth} onResize={onResize} />
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
        {view === "lyrics" ? lyrics : <SidebarTracks {...tracks} />}
      </div>
    </aside>
  );
}

const MIN_SIDEBAR_WIDTH = 320;
const MAX_SIDEBAR_WIDTH = 520;
const MIN_PAGE_WIDTH = 500;
const SIDEBAR_WIDTH_PROPERTY = "--playback-sidebar-width";

function PlaybackSidebarResize({ preferredWidth, onResize }: { preferredWidth: number | null; onResize: (width: number) => void }) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [requestedWidth, setRequestedWidth] = useState(preferredWidth);
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

  // Dragging saves once, where it stops.
  function resize(next: number, settled = true) {
    setRequestedWidth(clampWidth(next));
    if (settled) onResize(clampWidth(next));
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
        if (start?.pointerId === event.pointerId) resize(start.width + start.x - event.clientX, false);
      }}
      onLostPointerCapture={event => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        event.currentTarget.removeAttribute("data-resizing");
        onResize(width);
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

const ROW_HEIGHT = 64;
const VIRTUALIZE_AFTER_ROWS = 120;

type SidebarEntry = { id: string; track: Track; queueId?: QueueId; historyId?: string; current?: boolean };
type SidebarMenu =
  | { kind: "playback" | "collection" | "combined"; id: string; anchor: HTMLElement; x: number; y: number; flipY: number; keyboard: boolean; extendSelection?: boolean; instant?: boolean }
  | { kind: "selection"; anchor: HTMLButtonElement; x: number; y: number; flipY: number };
type RowAction = "play" | "start" | "playback" | "collection" | "combined" | "select";
type EntryAction = (action: RowAction, event: MouseEvent<HTMLElement>, entry: SidebarEntry) => void;

function SidebarTracks({
  currentTrack, isPlaying, onTogglePlayback, upcoming: upcomingEntries, history: historyEntries,
  onJumpTo, onReplayHistory, onRemove, onRemoveHistory, onReorder,
  recent, recentError, onRecentAction, onOpenEntity, playlistOptions, savedTrackIds, addToLibrary,
}: SidebarTracksProps) {
  const combinedMenu = useContext(SongContextMenu);
  const connected = useServiceAvailability();
  const scroller = useRef<HTMLDivElement>(null);
  const nowPlayingRef = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<SidebarMenu | null>(null);
  useEffect(() => setMenu(null), [combinedMenu]);
  // Played songs start folded into one line above now playing, so the queue opens on what's playing.
  const [historyOpen, setHistoryOpen] = useState(false);

  const current = useMemo<SidebarEntry | undefined>(() => currentTrack
    ? { id: `current:${currentTrack.globalId}`, track: currentTrack, current: true }
    : undefined, [currentTrack]);
  const upcoming = useMemo<SidebarEntry[]>(
    () => upcomingEntries.map(entry => ({ id: queueEntryKey(entry), track: entry.track, queueId: entry.queueId })),
    [upcomingEntries]);
  const queueHistory = useMemo<SidebarEntry[]>(
    () => historyEntries.map(entry => ({ id: `history:${entry.historyId}`, track: entry.track, historyId: entry.historyId })),
    [historyEntries]);
  // Played songs: older listening history, then this queue's own plays, the latest just above now playing.
  // A song this queue played, or is playing, shows only there.
  const history = useMemo<SidebarEntry[]>(() => {
    const inQueue = new Set([...queueHistory.map(entry => entry.track.globalId), currentTrack?.globalId]);
    const older = recent.filter(({ track }) => !inQueue.has(track.globalId))
      .sort((a, b) => a.lastPlayedAt - b.lastPlayedAt)
      .map(({ track }) => ({ id: `recent:${track.globalId}`, track }));
    return [...older, ...queueHistory];
  }, [queueHistory, recent, currentTrack?.globalId]);
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
  const menuCanOpen = menuAvailable || ((menu?.kind === "collection" || menu?.kind === "combined") && menuRemovable);
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
    upcomingIds, reorder, () => setMenu(null), scroller,
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

  function queueActions(entry: SidebarEntry): TrackCollectionAction[] {
    if (entry.queueId !== undefined) return [
      { label: "Play from Here", icon: "/skip.svg", onSelect: () => playEntry(entry) },
      { label: "Move to Front", icon: "/play-next.svg", whenUnavailable: true, disabled: upcoming[0] === entry, onSelect: () => moveToFront(entry) },
      { id: "remove", label: "Remove from Queue", icon: "/delete.svg", whenUnavailable: true, onSelect: () => removeEntries([entry]) },
    ];
    if (entry.historyId !== undefined) return [
      { label: "Play Again", icon: "/skip.svg", onSelect: () => playEntry(entry) },
      { id: "remove", label: "Remove from History", icon: "/delete.svg", whenUnavailable: true, onSelect: () => removeEntries([entry]) },
    ];
    return [];
  }

  function combinedPlaybackActions(entry: SidebarEntry) {
    if (entry.current) return isPlaying ? [pauseTrackAction(onTogglePlayback)] : [];
    if (entry.queueId !== undefined || entry.historyId !== undefined) return queueActions(entry);
    return trackPlaybackActions(entry.track.globalId, {
      playStandalone: () => onRecentAction("standalone", entry.track),
      playNext: () => onRecentAction("next", entry.track),
      addToQueue: () => onRecentAction("queue", entry.track),
    });
  }


  // Stable, so the playback clock and menus re-render only the rows they change.
  const actions = useRef<EntryAction>(() => {});
  actions.current = (action, event, entry) => {
    const available = isTrackAvailable(entry.track, connected);
    // A click that ended a drag never opens or plays anything.
    if (!entry.current && suppressClick.current && event.detail !== 0) return;
    if (action === "combined" || (action === "collection" && combinedMenu)) {
      if (!available && entry.queueId === undefined && entry.historyId === undefined) return;
      const keyboard = isKeyboardMenuClick(event);
      setMenu({ kind: "combined", id: entry.id, anchor: event.currentTarget, keyboard, ...songMenuPosition(event), extendSelection: event.shiftKey });
      return;
    }
    if (action === "select" || (!combinedMenu && selection.isSelecting && !entry.current && action !== "collection")) {
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
    if (action === "play" || action === "start") {
      if (action === "start" && entry.current && isPlaying) return;
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
      ? { kind: action, id: entry.id, anchor, x: rect.right - MENU_WIDTH - 4, y: rect.bottom + 4, flipY: rect.top - 4, keyboard }
      : { kind: action, id: entry.id, anchor, x: keyboard ? rect.left : event.clientX,
        // Just below the pointer, so it doesn't open already hovering the first action.
        y: keyboard ? rect.bottom : event.clientY + 2,
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
    combinedMenu, onAction, onOpenEntity, draggedId: draggedTrackId, dropTarget,
  };
  const upcomingDuration = upcoming.reduce((total, entry) => total + entry.track.durationSeconds, 0);
  const menuEntrySelected = menuEntry !== undefined && selection.selectedIds.has(menuEntry.id);

  return (
    <>
      {menu?.kind === "playback" && menuEntry && menuAvailable && (menuEntry.queueId !== undefined || menuEntry.historyId !== undefined
        ? <TrackCollectionMenu trackId={menuEntry.track.globalId} xPos={menu.x} yPos={menu.y} flipY={menu.flipY} onClose={closeMenu}
            fitContent downloads={false} actions={queueActions(menuEntry).filter(action => action.id !== "remove")} />
        : <TrackPlaybackMenu trackId={menuEntry.track.globalId} xPos={menu.x} yPos={menu.y} onClose={() => setMenu(null)}
            openedWithKeyboard={menu.keyboard} playStandalone={() => recentAction("standalone")}
            playNext={() => recentAction("next")} addToQueue={() => recentAction("queue")} />)}
      {(menu?.kind === "collection" || menu?.kind === "combined") && menuEntry && menuCanOpen && <TrackCollectionMenu trackId={menuEntry.track.globalId}
        xPos={menu.x} yPos={menu.y} flipY={menu.flipY} instant={menu.instant} onClose={closeMenu}
        playlistOptions={menuAvailable ? playlistOptions : undefined}
        actions={menuAvailable ? [
          ...(menu.kind === "combined" ? combinedPlaybackActions(menuEntry) : queueActions(menuEntry).filter(action => action.id === "remove")),
          ...(menuEntry.track.provider !== "local" && !savedTrackIds.has(menuEntry.track.globalId)
            ? [{ label: "Add to Library", icon: "/add.svg", onSelect: () => addToLibrary(menuEntry.track) }] : []),
          ...(menu.kind === "collection" ? [
            { label: "Go to Album", icon: "/album.svg", onSelect: () => onOpenEntity({ kind: "album", album: albumForTrack(menuEntry.track) }) },
            { label: "Credits", icon: "/credits.svg", onSelect: () => showTrackCredits(menuEntry.track) },
          ] : []),
          ...(menuEntry.current || menu.kind !== "combined" ? [] : [{
            label: menuEntrySelected ? "Deselect Song" : "Select Song",
            icon: menuEntrySelected ? "/select.svg" : "/no-select.svg",
            onSelect: () => selection.toggle(selectableIds.indexOf(menuEntry.id), Boolean(menu.extendSelection)),
          }]),
        ] : queueActions(menuEntry).filter(action => action.whenUnavailable)}
      />}
      {menu?.kind === "selection" && selected.length > 0 && <TrackCollectionMenu trackId="" actions={[]}
        tracks={[...new Map(selected.map(({ track }) => [track.globalId, track])).values()]}
        startWithPlaylistPicker playlistOptions={playlistOptions} xPos={menu.x} yPos={menu.y} flipY={menu.flipY} onClose={closeMenu} />}

      {selection.isSelecting && <div className="selectionActionMenu playbackSidebarSelection uiMenu" role="group" aria-label="Selected songs">
        <button type="button" className="selectionRemoveAction" disabled={!selected.some(entry => entry.queueId !== undefined || entry.historyId !== undefined)}
          onClick={() => removeEntries(selected)}>Remove</button>
        <button type="button" disabled={!selected.length} onClick={event => {
          const anchor = event.currentTarget;
          const rect = anchor.getBoundingClientRect();
          setMenu({ kind: "selection", anchor, x: Math.max(8, rect.right - MENU_WIDTH - 4), y: rect.bottom + 4, flipY: rect.top - 4 });
        }}>Add to Playlist</button>
        <button type="button" onClick={selection.clear}>Cancel</button>
      </div>}

      <div className="playbackSidebarScroll" ref={scroller} data-selecting={selection.isSelecting || undefined}>
        <>
          {history.length > 0 && <div className="playbackSidebarHeading playbackSidebarHistoryBar">
            <button type="button" className="playbackSidebarHistoryToggle" aria-expanded={historyOpen}
              aria-controls="playbackSidebarHistory" onClick={toggleHistory}>
              <DropdownChevron />Played ({history.length})
            </button>
            {/* Listening history isn't the queue's to clear; this clears the queue's own plays. */}
            {historyOpen && queueHistory.length > 0 && <button type="button" className="playbackSidebarTextButton"
              onClick={() => removeEntries(queueHistory)}>Clear</button>}
          </div>}
          {historyOpen && recentError && <p className="playbackSidebarMessage" role="alert">{recentError}</p>}
          {historyOpen && <SidebarRows id="playbackSidebarHistory" label="Played songs" entries={history} {...rowProps} />}

          <section className="playbackSidebarSection" ref={nowPlayingRef} aria-labelledby="playbackSidebarNowPlaying">
            <h2 className="playbackSidebarHeading" id="playbackSidebarNowPlaying">Now Playing</h2>
            {current
              ? <div className="playbackSidebarRows" role="list" aria-label="Now playing">
                  <SidebarRow entry={current} index={0} isPlaying={isPlaying} {...rowProps}
                    selected={false} menuOpen={menuId === current.id} dragging={false} />
                </div>
              : <p className="playbackSidebarMessage">Nothing is playing.</p>}
          </section>

          <section className="playbackSidebarSection" aria-labelledby="playbackSidebarUpNext">
            <div className="playbackSidebarHeading">
              <h2 id="playbackSidebarUpNext">Up Next</h2>
              {upcoming.length > 0 && <>
                <span className="playbackSidebarMeta">
                  {upcoming.length.toLocaleString()} {upcoming.length === 1 ? "song" : "songs"} · {formatTotalDuration(upcomingDuration)}
                </span>
                <button type="button" className="playbackSidebarTextButton" onClick={() => removeEntries(upcoming)}>Clear</button>
              </>}
            </div>
            {upcoming.length > 0
              ? <SidebarRows label="Upcoming songs" entries={upcoming} onPointerDown={onPointerDown} {...rowProps} />
              : <p className="playbackSidebarMessage">Nothing up next.</p>}
          </section>
        </>
      </div>
    </>
  );
}

type RowsProps = {
  selecting: boolean;
  combinedMenu: boolean;
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

/** A song row with the same parts, classes and gestures as every other song list (TrackList.tsx). */
const SidebarRow = memo(function SidebarRow({
  entry, index, selecting: selectionActive, selected, menuOpen, menuKind, combinedMenu, isPlaying = false, onAction, onOpenEntity,
  onPointerDown, dragging, dropPosition,
}: Omit<RowsProps, "selectedIds" | "menuId" | "draggedId" | "dropTarget"> & {
  entry: SidebarEntry;
  index: number;
  selected: boolean;
  menuOpen: boolean;
  dragging: boolean;
  isPlaying?: boolean;
  dropPosition?: DropPosition;
}) {
  const connected = useServiceAvailability();
  const { track } = entry;
  const available = isTrackAvailable(track, connected);
  const selecting = selectionActive && available && !entry.current;
  const collectionOpen = menuOpen && (menuKind === "collection" || menuKind === "combined");
  const pausing = entry.current && isPlaying;
  return (
    <div className="libraryItem playbackSidebarRow" role="listitem" data-track-id={entry.id} data-virtual-item=""
      data-unavailable={!available ? "true" : undefined} data-played={entry.historyId !== undefined ? "true" : undefined}
      data-now-playing={entry.current ? isPlaying ? "playing" : "paused" : undefined}
      aria-current={entry.current ? "true" : undefined}
      data-selecting={selecting ? "true" : undefined} data-selected={selected ? "true" : undefined}
      data-menu-open={menuOpen ? "true" : undefined} data-reorderable={onPointerDown && available ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined} data-drop-position={dropPosition}
      onPointerDown={onPointerDown && available ? event => onPointerDown(event, index) : undefined}
      onClickCapture={combinedMenu ? suppressSongClick : entry.current ? undefined : event => {
        if (selecting || ((event.shiftKey || event.metaKey || event.ctrlKey) && available && !isEntityLink(event.target))) onAction("select", event, entry);
      }}
      onClick={combinedMenu ? undefined : event => onAction("playback", event, entry)}
      onContextMenu={combinedMenu ? event => onAction("combined", event, entry)
        : entry.current ? undefined : event => onAction("select", event, entry)}
      onDoubleClick={combinedMenu ? event => playSongOnDoubleClick(event, () => onAction("start", event, entry)) : undefined}
      onDragStart={event => event.preventDefault()} draggable={false}>
      <div className="trackLeading" inert={!available && !entry.current}>
        <button type="button" className="trackPlayButton" disabled={!available && !entry.current}
          aria-label={`${pausing ? "Pause" : entry.historyId !== undefined ? "Play again" : "Play"} ${track.name}`}
          onClick={event => onAction("play", event, entry)}>
          <img src={pausing ? "/pause.svg" : "/play.svg"} alt="" aria-hidden="true" />
        </button>
        <button type="button" className="coverImgContainer" data-track-cover-play data-drag-handle
          disabled={!available && !entry.current}
          aria-label={`${pausing ? "Pause" : entry.historyId !== undefined ? "Play again" : "Play"} ${track.name} (cover)`}
          onClick={event => {
            event.stopPropagation();
            if (event.detail <= 1) onAction("play", event, entry);
          }}>
          <TrackArtwork track={track} alt="" className="coverImg" draggable={false} />
        </button>
      </div>
      <span className="trackName playbackSidebarTrackText" data-playback-menu-trigger inert={!available}>
        {selecting ? <span className="trackTitleText" title={track.name}>{track.name}</span>
          : <TrackTitleLink track={track} onOpenEntity={onOpenEntity} className="trackTitleText" />}
        <small className="playbackSidebarArtists"><ArtistLinks track={track} onOpenEntity={onOpenEntity} /></small>
      </span>
      <button type="button" className="trackCollectionMenuTrigger"
        disabled={!available && entry.queueId === undefined && entry.historyId === undefined}
        aria-label={`${selecting && !combinedMenu ? selected ? "Deselect" : "Select" : "Actions for"} ${track.name}`}
        aria-pressed={selecting && !combinedMenu ? selected : undefined}
        aria-haspopup={selecting && !combinedMenu ? undefined : "menu"}
        aria-expanded={selecting && !combinedMenu ? undefined : collectionOpen}
        data-collection-menu-trigger data-collection-menu-open={collectionOpen && !selecting ? "true" : undefined}
        onClick={event => onAction("collection", event, entry)}>
        <img src={selecting ? selected ? "/select.svg" : "/no-select.svg" : "/menu.svg"}
          alt="" className={selecting ? "selectionIndicator" : undefined} />
      </button>
    </div>
  );
});
