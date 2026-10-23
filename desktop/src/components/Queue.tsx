import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { QueueEntry, QueueHistoryEntry, QueueId, Track } from "../types/music";
import { useRangeSelection } from "../hooks/useRangeSelection";
import { useTrackReorder } from "../hooks/useTrackReorder";
import { useVirtualWindow } from "../hooks/useVirtualWindow";
import type { QueueEntryRef } from "../utils/queueNavigation";
import { formatTotalDuration } from "../utils/totalDuration";
import type { DropPosition } from "../utils/trackCollectionOrder";
import { TrackArtwork } from "./TrackArtwork";
import { TrackCollectionMenu, type PlaylistMenuOptions } from "./TrackCollectionMenu";
import { MENU_WIDTH } from "../utils/trackMenu";
import { showTrackCredits } from "../utils/trackCredits";
import { DropdownChevron } from "./DropdownChevron";
import { TrackColumnHeader } from "./TrackColumnHeader";
import { TrackExtraCells } from "./TrackExtraCells";
import { usePageFilter, usePageReveal, useReportPageMatches, type PageReveal } from "../hooks/usePageFilter";
import { revealListItem } from "../utils/revealListItem";
import { trackMatches } from "../utils/trackFilter";
import { PerfProfiler } from "./PerfProfiler";
import { VirtualSpacer } from "./VirtualSpacer";
import { trackArtistNames } from "../utils/trackArtists";
import { albumForTrack, type BrowseEntity } from "../utils/browse";
import { ArtistLinks } from "./ArtistLinks";
import "./LibraryView.css";
import "./Queue.css";

export type QueueProps = {
  currentEntry: QueueEntry | undefined;
  upcomingEntries: QueueEntry[];
  historyEntries: QueueHistoryEntry[];
  jumpTo: (queueId: QueueId) => void;
  replayHistory: (historyId: string) => void;
  reorderEntries: (history: QueueEntryRef[], upcoming: QueueEntryRef[]) => void;
  deleteEntries: (queueIds: QueueId[]) => void;
  deleteHistoryEntries: (historyIds: string[]) => void;
  registerScrollElement: (element: HTMLDivElement | null) => void;
  /** The same library and playlist actions every other song list offers. */
  playlistOptions?: PlaylistMenuOptions;
  savedTrackIds?: ReadonlySet<string>;
  addToLibrary?: (track: Track) => void;
  onOpenEntity: (entity: BrowseEntity) => void;
};

type DisplayEntry = {
  id: string;
  track: Track;
  queueId?: QueueId;
  historyId?: string;
  current?: boolean;
  played?: boolean;
};
type MenuKind = "playback" | "collection";
type RowAction = "select" | MenuKind | "play";
type EntryAction = (action: RowAction, event: React.MouseEvent<HTMLElement>, entry: DisplayEntry) => void;

function queueEntry(entry: QueueEntry, current = false): DisplayEntry {
  // Queue IDs are positions, so include the source identity to invalidate old gestures after playback advances.
  return {
    id: `queue:${entry.queueId}:${entry.track.globalId}:${entry.source.kind}:${entry.source.id}:${entry.source.entryId}`,
    track: entry.track,
    queueId: entry.queueId,
    current,
  };
}

export function Queue(props: QueueProps) {
  const current = useMemo(() => props.currentEntry ? queueEntry(props.currentEntry, true) : undefined, [props.currentEntry]);
  const upcoming = useMemo(() => props.upcomingEntries.map(entry => queueEntry(entry)), [props.upcomingEntries]);
  const history = useMemo(() => props.historyEntries.map(entry => ({
    id: `history:${entry.historyId}`, track: entry.track, historyId: entry.historyId, played: true,
  })), [props.historyEntries]);
  // History starts folded into a single row above now playing, so the queue opens on what is playing.
  const [historyOpen, setHistoryOpen] = useState(false);
  // The page filter narrows every section, searching history only while it is unfolded;
  // reordering waits until it is cleared.
  const { terms } = usePageFilter();
  const filtering = terms.length > 0;
  const matchedHistory = useMemo(() => filtering && historyOpen ? history.filter(entry => trackMatches(entry.track, terms)) : [], [history, terms, filtering, historyOpen]);
  const matchedUpcoming = useMemo(() => filtering ? upcoming.filter(entry => trackMatches(entry.track, terms)) : [], [upcoming, terms, filtering]);
  const matchedCurrent = filtering && current && trackMatches(current.track, terms) ? current : undefined;
  const matchedIds = useMemo(() => [...matchedHistory, ...(matchedCurrent ? [matchedCurrent] : []), ...matchedUpcoming].map(entry => entry.id),
    [matchedHistory, matchedCurrent, matchedUpcoming]);
  useReportPageMatches(filtering ? matchedIds.length : null);
  // A lone match is shown where it sits rather than on its own.
  const reveal = usePageReveal(matchedIds, filtering);
  const narrowed = filtering && !reveal.target;
  const shownHistory = narrowed ? matchedHistory : history;
  const shownUpcoming = narrowed ? matchedUpcoming : upcoming;
  const shownCurrent = narrowed ? matchedCurrent : current;
  const entries = useMemo(() => [...shownHistory, ...(shownCurrent ? [shownCurrent] : []), ...shownUpcoming], [shownCurrent, shownUpcoming, shownHistory]);
  const ids = useMemo(() => entries.map(entry => entry.id), [entries]);
  const selectableIds = useMemo(() => ids.filter(id => id !== current?.id), [ids, current?.id]);
  const selection = useRangeSelection(selectableIds);
  const [menu, setMenu] = useState<{ kind: MenuKind; entry: DisplayEntry; x: number; y: number; flipY: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);
  const columnHeaderRef = useRef<HTMLDivElement>(null);
  const historyBarRef = useRef<HTMLDivElement>(null);
  const followCurrent = useRef(true);
  // Scrolled away from now playing, which offers the way back.
  const [awayFromCurrent, setAwayFromCurrent] = useState(false);
  const historyShown = historyOpen && shownHistory.length > 0;
  const setScrollElement = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    props.registerScrollElement(element);
  }, [props.registerScrollElement]);
  const currentScrollTop = useCallback(() => {
    const scroller = scrollRef.current;
    const anchor = currentRef.current;
    // Folded, history is one row; it stays in view instead of being scrolled past.
    if (!scroller || !anchor || !historyShown) return 0;
    const scrollerTop = scroller.getBoundingClientRect().top;
    // Now playing settles just below the sticky history bar rather than underneath it.
    const stickyBottom = historyBarRef.current ? historyBarRef.current.getBoundingClientRect().bottom - scrollerTop : 0;
    return Math.max(0, anchor.getBoundingClientRect().top - scrollerTop + scroller.scrollTop - stickyBottom);
  }, [historyShown]);
  const jumpToCurrent = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = currentScrollTop();
    followCurrent.current = true;
    setAwayFromCurrent(false);
  }, [currentScrollTop]);
  useLayoutEffect(() => {
    if (!followCurrent.current) return;
    // Run after the app's saved-scroll restoration so opening the queue lands at now playing.
    const frame = requestAnimationFrame(jumpToCurrent);
    return () => cancelAnimationFrame(frame);
  }, [current?.id, history.length, jumpToCurrent]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const tail = tailRef.current;
    if (!scroller || !tail) return;
    // Like Roon, now playing can always scroll to the top, even when little or nothing follows it.
    const fit = () => {
      tail.style.minHeight = `${scroller.clientHeight}px`;
      if (followCurrent.current) jumpToCurrent();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [jumpToCurrent]);

  function trackScrollPosition() {
    followCurrent.current = Math.abs((scrollRef.current?.scrollTop ?? 0) - currentScrollTop()) <= 24;
    setAwayFromCurrent(!followCurrent.current);
    const scroller = scrollRef.current;
    const bar = historyBarRef.current;
    setHistoryBarStuck(Boolean(scroller && bar && scroller.scrollTop > 0
      && bar.getBoundingClientRect().top - scroller.getBoundingClientRect().top <= columnHeaderHeight + 1));
  }

  // Where now playing sat on screen just before history unfolded above it.
  const tailTopBeforeOpen = useRef<number | null>(null);
  function toggleHistory() {
    const open = !historyOpen;
    tailTopBeforeOpen.current = open && scrollRef.current && tailRef.current
      ? tailRef.current.getBoundingClientRect().top - scrollRef.current.getBoundingClientRect().top
      : null;
    setHistoryOpen(open);
    followCurrent.current = !open;
  }
  // Unfolding reveals the latest plays, right above now playing, which moves down at most to the
  // middle of the list; older plays are further up.
  useLayoutEffect(() => {
    const before = tailTopBeforeOpen.current;
    tailTopBeforeOpen.current = null;
    const scroller = scrollRef.current;
    const tail = tailRef.current;
    if (before === null || !scroller || !tail) return;
    const grown = tail.getBoundingClientRect().top - scroller.getBoundingClientRect().top - before;
    const shift = Math.min(grown, Math.max(0, scroller.clientHeight / 2 - before));
    scroller.scrollTop += grown - shift;
  }, [historyOpen]);
  // The history bar sticks under the column header, so folding and clearing stay in reach. It
  // sticks over the header's bottom fade, which would otherwise show rows scrolling between them.
  const [columnHeaderHeight, setColumnHeaderHeight] = useState(0);
  // Stuck, the history bar carries the fade rows scroll under.
  const [historyBarStuck, setHistoryBarStuck] = useState(false);
  useLayoutEffect(() => {
    const header = columnHeaderRef.current;
    if (!header) return;
    const measure = () => setColumnHeaderHeight(header.offsetHeight - parseFloat(getComputedStyle(header).paddingBottom));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [entries.length > 0]);
  // History and upcoming reorder as one list; whatever lands behind now playing is history, the rest is up next.
  const reorder = useCallback((orderedIds: string[]) => {
    const refs = new Map<string, QueueEntryRef>();
    for (const entry of entries as DisplayEntry[]) {
      if (entry.historyId !== undefined) refs.set(entry.id, { historyId: entry.historyId });
      else if (entry.queueId !== undefined && !entry.current) refs.set(entry.id, { queueId: entry.queueId });
    }
    const split = current ? orderedIds.indexOf(current.id) : orderedIds.length;
    const others = orderedIds.filter(id => id !== current?.id);
    if (split < 0 || others.some(id => !refs.has(id))) return;
    props.reorderEntries(others.slice(0, split).map(id => refs.get(id)!), others.slice(split).map(id => refs.get(id)!));
  }, [entries, current, props.reorderEntries]);
  const { draggedTrackId, dropTarget, suppressClick, onPointerDown } = useTrackReorder(
    ids, narrowed ? undefined : reorder, () => setMenu(null), scrollRef, scrollRef,
  );
  // Up next rows count from 0, but sit after history and now playing in the shared list.
  const upcomingOffset = shownHistory.length + (shownCurrent ? 1 : 0);
  const onUpcomingPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, index: number) =>
    onPointerDown(event, upcomingOffset + index), [onPointerDown, upcomingOffset]);
  const signature = ids.join("|");
  useEffect(() => {
    selection.clear();
    setMenu(null);
  }, [signature, selection.clear]);

  function playEntry(entry: DisplayEntry) {
    if (entry.current) return;
    if (entry.historyId) props.replayHistory(entry.historyId);
    else if (entry.queueId !== undefined) props.jumpTo(entry.queueId);
  }

  function removeEntries(removed: DisplayEntry[]) {
    const queueIds = removed.flatMap(entry => entry.queueId === undefined ? [] : [entry.queueId]);
    const historyIds = removed.flatMap(entry => entry.historyId === undefined ? [] : [entry.historyId]);
    if (queueIds.length) props.deleteEntries(queueIds);
    if (historyIds.length) props.deleteHistoryEntries(historyIds);
    selection.clear();
    setMenu(null);
  }

  const actions = useRef<EntryAction>(() => {});
  actions.current = (action, event, entry) => {
    if (entry.current && action !== "collection") return;
    if (suppressClick.current && !entry.current && action !== "select") return;
    if (!entry.current && (action === "select" || selection.isSelecting)) {
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      selection.toggle(selectableIds.indexOf(entry.id), event.shiftKey);
    } else if (action === "play") {
      event.stopPropagation();
      setMenu(null);
      playEntry(entry);
    } else if (action === "playback" || action === "collection") {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      const trigger = action === "collection";
      setMenu({ kind: action, entry, x: trigger ? rect.right - MENU_WIDTH : event.clientX, y: trigger ? rect.bottom + 4 : event.clientY, flipY: trigger ? rect.top - 4 : event.clientY });
    }
  };
  const onAction = useCallback<EntryAction>((action, event, entry) => actions.current(action, event, entry), []);
  const rowProps = { selecting: selection.isSelecting, selectedIds: selection.selectedIds, menuEntryId: menu?.entry.id, menuKind: menu?.kind, onAction, onOpenEntity: props.onOpenEntity, reveal };
  // Now playing has its own place to go back to; anything else is scrolled to by its list.
  useLayoutEffect(() => {
    if (!reveal.key) return;
    if (reveal.target === current?.id) jumpToCurrent();
    else followCurrent.current = false;
  }, [reveal.key]);
  const duration = props.upcomingEntries.reduce((total, entry) => total + entry.track.durationSeconds, 0);

  return (
    <PerfProfiler id="queue">
      {menu && <TrackCollectionMenu key={`${menu.entry.id}:${menu.kind}`} trackId={menu.entry.track.globalId} onClose={() => setMenu(null)}
        playlistOptions={menu.kind === "collection" ? props.playlistOptions : undefined}
        xPos={menu.x} yPos={menu.y} flipY={menu.flipY} actions={menu.kind === "playback" ? [
          { label: "Play from here", icon: "/skip.svg", onSelect: () => playEntry(menu.entry) },
          { label: menu.entry.historyId ? "Remove from history" : "Remove from queue", icon: "/delete.svg", onSelect: () => removeEntries([menu.entry]) },
        ] : [
          ...(props.addToLibrary && menu.entry.track.provider !== "local" && !props.savedTrackIds?.has(menu.entry.track.globalId)
            ? [{ label: "Add to Library", icon: "/add.svg", onSelect: () => props.addToLibrary!(menu.entry.track) }] : []),
          { label: "Credits", icon: "/credits.svg", onSelect: () => showTrackCredits(menu.entry.track) },
        ]} />}
      {selection.isSelecting && (
        <div className="selectionActionMenu" role="group" aria-label="Selected queue entries">
          <button type="button" className="selectionRemoveAction" disabled={!selection.selectedIds.size}
            onClick={() => removeEntries(entries.filter(entry => selection.selectedIds.has(entry.id)))}>Remove</button>
          <button type="button" onClick={selection.clear}>Cancel</button>
        </div>
      )}
      <div className="queueView">
        <header className="libraryHeader queueHeader">
          <h1 className="libraryTitle">Queue</h1>
          <div className="libraryInfo">
            <span>{upcoming.length ? `${upcoming.length} ${upcoming.length === 1 ? "song" : "songs"} up next` : "Nothing up next"}</span>
            {upcoming.length > 0 && <><span className="separator">•</span><span>{formatTotalDuration(duration)}</span>
              <span className="separator">•</span>
              <button type="button" className="queueTextButton" onClick={() => removeEntries(upcoming)}>Clear</button></>}
          </div>
        </header>
        <div id="queueList" className="libraryView smoothScroll" ref={setScrollElement} onScroll={trackScrollPosition}
          data-selecting={selection.isSelecting ? "true" : undefined}>
          {(history.length > 0 || current || upcoming.length > 0) && <TrackColumnHeader headerRef={columnHeaderRef} />}
          {history.length > 0 && <div className="queueHistoryBar" ref={historyBarRef}
            data-stuck={historyBarStuck ? "true" : undefined}
            style={{ "--queue-column-header-height": `${columnHeaderHeight}px` } as React.CSSProperties}>
            <button type="button" className="queueSectionTitle queueHistoryToggle" aria-expanded={historyShown}
              aria-controls="queueHistory" onClick={toggleHistory}>
              <DropdownChevron />Played ({history.length})
            </button>
            {historyShown && !narrowed && <button type="button" className="queueTextButton"
              onClick={() => removeEntries(history)}>Clear</button>}
          </div>}
          <section id="queueHistory" className="queueSection" aria-label="Played tracks" hidden={!historyShown}>
            {historyShown && <QueueRows entries={shownHistory} label="Queue history" {...rowProps} onPointerDown={narrowed ? undefined : onPointerDown}
              draggedId={draggedTrackId} dropTarget={dropTarget} />}
          </section>
          <div className="queueTail" ref={tailRef}>
            <section id="currentQueueTrack" className="queueSection" aria-label="Now playing" ref={currentRef} hidden={!shownCurrent}>
              <h2 className="queueSectionTitle">Now Playing</h2>
              {shownCurrent && <QueueRow entry={shownCurrent} index={0} {...rowProps} selected={selection.selectedIds.has(shownCurrent.id)}
                revealed={reveal.breathing && reveal.target === shownCurrent.id}
                menuOpen={menu?.entry.id === shownCurrent.id}
                dropPosition={dropTarget?.trackId === shownCurrent.id ? dropTarget.position : undefined} />}
            </section>
            <section id="upcomingQueueTracks" className="queueSection" aria-label="Upcoming tracks" hidden={!shownUpcoming.length}>
              <h2 className="queueSectionTitle">Up Next</h2>
              <QueueRows entries={shownUpcoming} label="Upcoming queue" {...rowProps} onPointerDown={narrowed ? undefined : onUpcomingPointerDown}
                draggedId={draggedTrackId} dropTarget={dropTarget} />
            </section>
            {!history.length && !current && !upcoming.length && <p className="queueEmpty">Queue is empty</p>}
          </div>
        </div>
        {current && awayFromCurrent && (
          <button type="button" className="queueResume" onClick={jumpToCurrent}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m6 4 8 6-8 6Z" />
            </svg>
            Back to now playing
          </button>
        )}
      </div>
    </PerfProfiler>
  );
}

type RowProps = {
  selecting: boolean;
  selectedIds: ReadonlySet<string>;
  menuEntryId?: string;
  menuKind?: MenuKind;
  reveal: PageReveal;
  onAction: EntryAction;
  onOpenEntity: (entity: BrowseEntity) => void;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>, index: number) => void;
};

function QueueRows({ entries, label, draggedId, dropTarget, reveal, ...props }: RowProps & {
  entries: DisplayEntry[];
  label: string;
  draggedId?: string | null;
  dropTarget?: { trackId: string; position: DropPosition } | null;
}) {
  const rowsRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualWindow({
    count: entries.length, enabled: entries.length > 120, probeRef: rowsRef, probeIsContainer: true,
    fallback: { rowHeight: 76 }, cacheKey: label, overscanRows: 10,
    pinnedIndex: draggedId ? entries.findIndex(entry => entry.id === draggedId) : null,
  });
  const revealIndex = reveal.target ? entries.findIndex(entry => entry.id === reveal.target) : -1;
  useLayoutEffect(() => {
    if (reveal.key && revealIndex >= 0 && rowsRef.current) revealListItem(rowsRef.current, revealIndex, virtual.start);
  }, [reveal.key]);
  return (
    <div className="queueEntries" role="list" aria-label={label} ref={rowsRef}>
      {virtual.topSpace > 0 && <VirtualSpacer position="top" height={virtual.topSpace} />}
      {entries.slice(virtual.start, virtual.end).map((entry, offset) => <QueueRow
        key={entry.id} entry={entry} index={virtual.start + offset} {...props}
        selected={props.selectedIds.has(entry.id)} menuOpen={props.menuEntryId === entry.id} dragging={entry.id === draggedId}
        revealed={reveal.breathing && reveal.target === entry.id}
        dropPosition={dropTarget?.trackId === entry.id ? dropTarget.position : undefined}
      />)}
      {virtual.bottomSpace > 0 && <VirtualSpacer position="bottom" height={virtual.bottomSpace} />}
    </div>
  );
}

function formatDuration(durationSeconds: number) {
  const seconds = Math.max(0, Math.floor(durationSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// Mirrors TrackList's rows so the queue reads like any other collection.
const QueueRow = memo(function QueueRow({ entry, index, selecting: selectionActive, selected, menuOpen, menuKind, onAction, onOpenEntity, onPointerDown, dragging, dropPosition, revealed }: Omit<RowProps, "selectedIds" | "menuEntryId" | "reveal"> & {
  entry: DisplayEntry;
  index: number;
  selected: boolean;
  menuOpen?: boolean;
  dragging?: boolean;
  dropPosition?: DropPosition;
  /** The filter's only match, breathing until the listener does anything. */
  revealed?: boolean;
}) {
  const selecting = selectionActive && !entry.current;
  const collectionMenuOpen = menuOpen && menuKind === "collection";
  const artists = trackArtistNames(entry.track);
  return (
    <div className="libraryItem queueItem" role="listitem" data-virtual-item="" data-track-id={entry.id}
      data-revealed={revealed ? "true" : undefined}
      data-selected={selected ? "true" : undefined} data-selecting={selecting ? "true" : undefined}
      data-menu-open={menuOpen ? "true" : undefined}
      data-current={entry.current ? "true" : undefined} data-reorderable={onPointerDown ? "true" : undefined}
      data-played={entry.played ? "true" : undefined} aria-current={entry.current ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined} data-drop-position={dropPosition} draggable={false}
      onClickCapture={event => { if (selecting) onAction("select", event, entry); }}
      onClick={entry.current ? undefined : event => onAction("playback", event, entry)}
      onContextMenu={entry.current ? undefined : event => onAction("select", event, entry)}
      onPointerDown={event => onPointerDown?.(event, index)} onDragStart={event => event.preventDefault()}>
      <div className="trackLeading">
        <button type="button" className="trackPlayButton" disabled={entry.current}
          aria-label={entry.current ? `${entry.track.name} is playing` : `Play ${entry.track.name}`}
          onClick={event => onAction("play", event, entry)}>
          <img src="/play.svg" alt="" aria-hidden="true" />
        </button>
        <div className="coverImgContainer"><TrackArtwork track={entry.track} alt={`${entry.track.album} album cover`} className="coverImg" draggable={false} /></div>
      </div>
      <span className="trackName trackDescriptor">
        <span className="trackTitleText" title={entry.track.name}>{entry.track.name}</span>
        <small className="queueTrackArtist"><ArtistLinks track={entry.track} onOpenEntity={onOpenEntity} /></small>
      </span>
      <span className="artistName trackDescriptor" title={artists}><ArtistLinks track={entry.track} onOpenEntity={onOpenEntity} /></span>
      <span className="albumName trackDescriptor" title={entry.track.album}>
        <button type="button" className="entityLink" onClick={event => { event.stopPropagation(); onOpenEntity({ kind: "album", album: albumForTrack(entry.track) }); }}>{entry.track.album}</button>
      </span>
      <TrackExtraCells track={entry.track} />
      <span className="trackDuration trackDescriptor">{formatDuration(entry.track.durationSeconds)}</span>
      <button type="button" className="trackCollectionMenuTrigger"
        aria-label={`${selecting ? selected ? "Deselect" : "Select" : "Library options for"} ${entry.track.name}`}
        aria-haspopup={selecting ? undefined : "menu"}
        aria-expanded={selecting ? undefined : collectionMenuOpen}
        onClick={event => onAction("collection", event, entry)}
        data-collection-menu-trigger data-collection-menu-open={collectionMenuOpen && !selecting ? "true" : undefined}>
        <img src={selecting ? selected ? "/select.svg" : "/no-select.svg" : "/menu.svg"}
          alt={selecting ? "Selection status" : "Menu"} className={selecting ? "selectionIndicator" : undefined} />
      </button>
    </div>
  );
});
