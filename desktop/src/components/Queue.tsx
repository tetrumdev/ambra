import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { QueueEntry, QueueHistoryEntry, QueueId, Track } from "../types/music";
import { useRangeSelection } from "../hooks/useRangeSelection";
import { useTrackReorder } from "../hooks/useTrackReorder";
import { useVirtualWindow } from "../hooks/useVirtualWindow";
import type { QueueEntryRef } from "../utils/queueNavigation";
import { formatTotalDuration } from "../utils/totalDuration";
import type { DropPosition } from "../utils/trackCollectionOrder";
import { TrackArtwork } from "./TrackArtwork";
import { MENU_WIDTH, TrackCollectionMenu } from "./TrackCollectionMenu";
import { TrackColumnHeader } from "./TrackColumnHeader";
import { PerfProfiler } from "./PerfProfiler";
import { VirtualSpacer } from "./VirtualSpacer";
import { trackArtistNames } from "./ArtistLinks";
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
};

type DisplayEntry = {
  id: string;
  track: Track;
  queueId?: QueueId;
  historyId?: string;
  current?: boolean;
  played?: boolean;
};
type RowAction = "select" | "menu" | "play";
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
  const entries = useMemo(() => [...history, ...(current ? [current] : []), ...upcoming], [current, upcoming, history]);
  const ids = useMemo(() => entries.map(entry => entry.id), [entries]);
  const selection = useRangeSelection(ids);
  const [menu, setMenu] = useState<{ entry: DisplayEntry; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);
  const followCurrent = useRef(true);
  const setScrollElement = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    props.registerScrollElement(element);
  }, [props.registerScrollElement]);
  const currentScrollTop = useCallback(() => {
    const scroller = scrollRef.current;
    const anchor = currentRef.current;
    if (!scroller || !anchor) return 0;
    return Math.max(0, anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      + scroller.scrollTop);
  }, []);
  const jumpToCurrent = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = currentScrollTop();
    followCurrent.current = true;
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
  }

  function showHistory() {
    followCurrent.current = false;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }
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
    ids, reorder, () => setMenu(null), scrollRef, scrollRef,
  );
  // Up next rows count from 0, but sit after history and now playing in the shared list.
  const upcomingOffset = history.length + (current ? 1 : 0);
  const onUpcomingPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, index: number) =>
    onPointerDown(event, upcomingOffset + index), [onPointerDown, upcomingOffset]);
  const signature = ids.join("|");
  useEffect(() => {
    selection.clear();
    setMenu(null);
  }, [signature, selection.clear]);

  function playEntry(entry: DisplayEntry) {
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
    if (suppressClick.current && !entry.current && action !== "select") return;
    if (action === "select" || selection.isSelecting) {
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      selection.toggle(ids.indexOf(entry.id), event.shiftKey);
    } else if (action === "play") {
      event.stopPropagation();
      setMenu(null);
      playEntry(entry);
    } else if (action === "menu") {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      const trigger = event.currentTarget.hasAttribute("data-collection-menu-trigger");
      setMenu({ entry, x: trigger ? rect.right - MENU_WIDTH : event.clientX, y: trigger ? rect.bottom + 4 : event.clientY });
    } else {
      setMenu(null);
      playEntry(entry);
    }
  };
  const onAction = useCallback<EntryAction>((action, event, entry) => actions.current(action, event, entry), []);
  const rowProps = { selecting: selection.isSelecting, selectedIds: selection.selectedIds, menuEntryId: menu?.entry.id, onAction };
  const columnHeaderRef = useRef<HTMLDivElement>(null);
  const duration = props.upcomingEntries.reduce((total, entry) => total + entry.track.durationSeconds, 0);

  return (
    <PerfProfiler id="queue">
      {menu && <TrackCollectionMenu trackId={menu.entry.track.globalId} onClose={() => setMenu(null)}
        xPos={menu.x} yPos={menu.y} actions={[
          ...(!menu.entry.current ? [{ label: "Play from here", icon: "/skip.svg", onSelect: () => playEntry(menu.entry) }] : []),
          { label: menu.entry.historyId ? "Remove from history" : "Remove from queue", onSelect: () => removeEntries([menu.entry]) },
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
          <div className="libraryPlayActions">
            {current && <button type="button" className="libraryPlayBtn" onClick={jumpToCurrent}>
              <img src="/Play.svg" alt="" aria-hidden="true" />
              <span>NOW PLAYING</span>
            </button>}
            <button type="button" className="libraryShuffleBtn" disabled={!history.length} onClick={showHistory}>
              <span>HISTORY</span>
            </button>
            <button type="button" className="libraryShuffleBtn" disabled={!entries.length}
              onClick={() => removeEntries(upcoming.length ? upcoming : entries)}>
              <span>{upcoming.length || !entries.length ? "CLEAR UPCOMING" : "CLEAR ALL"}</span>
            </button>
          </div>
          <div className="libraryInfo">
            <span className="numOfTracks">{upcoming.length} {upcoming.length === 1 ? "song" : "songs"} up next</span>
            {upcoming.length > 0 && <><span className="separator">•</span><span className="playlistLength">{formatTotalDuration(duration)}</span></>}
            {history.length > 0 && <><span className="separator">•</span><span>{history.length} played</span></>}
          </div>
        </header>
        <div id="queueList" className="libraryView smoothScroll" ref={setScrollElement} onScroll={trackScrollPosition}
          data-selecting={selection.isSelecting ? "true" : undefined}>
          {entries.length > 0 && <TrackColumnHeader headerRef={columnHeaderRef} />}
          <section id="queueHistory" className="queueSection" aria-label="Played tracks" hidden={!history.length}>
            <h2 className="queueSectionTitle">History</h2>
            <QueueRows entries={history} label="Queue history" {...rowProps} onPointerDown={onPointerDown}
              draggedId={draggedTrackId} dropTarget={dropTarget} />
          </section>
          <div className="queueTail" ref={tailRef}>
            <section id="currentQueueTrack" className="queueSection" aria-label="Now playing" ref={currentRef} hidden={!current}>
              <h2 className="queueSectionTitle">Now Playing</h2>
              {current && <QueueRow entry={current} index={0} {...rowProps} selected={selection.selectedIds.has(current.id)}
                menuOpen={menu?.entry.id === current.id}
                dropPosition={dropTarget?.trackId === current.id ? dropTarget.position : undefined} />}
            </section>
            <section id="upcomingQueueTracks" className="queueSection" aria-label="Upcoming tracks" hidden={!upcoming.length}>
              <h2 className="queueSectionTitle">Up Next</h2>
              <QueueRows entries={upcoming} label="Upcoming queue" {...rowProps} onPointerDown={onUpcomingPointerDown}
                draggedId={draggedTrackId} dropTarget={dropTarget} />
            </section>
            {!entries.length && <p className="queueEmpty">Queue is empty</p>}
          </div>
        </div>
      </div>
    </PerfProfiler>
  );
}

type RowProps = {
  selecting: boolean;
  selectedIds: ReadonlySet<string>;
  menuEntryId?: string;
  onAction: EntryAction;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>, index: number) => void;
};

function QueueRows({ entries, label, draggedId, dropTarget, ...props }: RowProps & {
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
  return (
    <div className="queueEntries" role="list" aria-label={label} ref={rowsRef}>
      {virtual.topSpace > 0 && <VirtualSpacer position="top" height={virtual.topSpace} />}
      {entries.slice(virtual.start, virtual.end).map((entry, offset) => <QueueRow
        key={entry.id} entry={entry} index={virtual.start + offset} {...props}
        selected={props.selectedIds.has(entry.id)} menuOpen={props.menuEntryId === entry.id} dragging={entry.id === draggedId}
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
const QueueRow = memo(function QueueRow({ entry, index, selecting, selected, menuOpen, onAction, onPointerDown, dragging, dropPosition }: Omit<RowProps, "selectedIds" | "menuEntryId"> & {
  entry: DisplayEntry;
  index: number;
  selected: boolean;
  menuOpen?: boolean;
  dragging?: boolean;
  dropPosition?: DropPosition;
}) {
  const artists = trackArtistNames(entry.track);
  return (
    <div className="libraryItem queueItem" role="listitem" data-virtual-item="" data-track-id={entry.id}
      data-selected={selected ? "true" : undefined} data-selecting={selecting ? "true" : undefined}
      data-menu-open={menuOpen ? "true" : undefined}
      data-current={entry.current ? "true" : undefined} data-reorderable={onPointerDown ? "true" : undefined}
      data-played={entry.played ? "true" : undefined} aria-current={entry.current ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined} data-drop-position={dropPosition} draggable={false}
      onClickCapture={event => { if (selecting) onAction("select", event, entry); }}
      onClick={event => onAction("menu", event, entry)}
      onContextMenu={event => onAction("select", event, entry)}
      onPointerDown={event => onPointerDown?.(event, index)} onDragStart={event => event.preventDefault()}>
      <div className="trackLeading">
        <button type="button" className="trackPlayButton" disabled={entry.current}
          aria-label={entry.current ? `${entry.track.name} is playing` : `Play ${entry.track.name}`}
          onClick={event => onAction("play", event, entry)}>
          <img src="/Play.svg" alt="" aria-hidden="true" />
        </button>
        <div className="coverImgContainer"><TrackArtwork track={entry.track} alt={`${entry.track.album} album cover`} className="coverImg" draggable={false} /></div>
      </div>
      <span className="trackName trackDescriptor">
        <span className="trackTitleText" title={entry.track.name}>{entry.track.name}</span>
        <small className="queueTrackArtist">{artists}</small>
      </span>
      <span className="artistName trackDescriptor" title={artists}>{artists}</span>
      <span className="albumName trackDescriptor" title={entry.track.album}>{entry.track.album}</span>
      <span className="trackDuration trackDescriptor">{formatDuration(entry.track.durationSeconds)}</span>
      <button type="button" className="trackCollectionMenuTrigger"
        aria-label={`${selecting ? selected ? "Deselect" : "Select" : "Actions for"} ${entry.track.name}`}
        aria-expanded={selecting ? undefined : menuOpen}
        onClick={event => onAction("menu", event, entry)}
        data-collection-menu-trigger data-collection-menu-open={menuOpen && !selecting ? "true" : undefined}>
        <img src={selecting ? selected ? "/select.svg" : "/noSelect.svg" : "/menu.svg"}
          alt={selecting ? "Selection status" : "Menu"} className={selecting ? "selectionIndicator" : undefined} />
      </button>
    </div>
  );
});
