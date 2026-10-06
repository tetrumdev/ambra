import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { QueueEntry, QueueHistoryEntry, QueueId, Track } from "../types/music";
import { useRangeSelection } from "../hooks/useRangeSelection";
import { useTrackReorder } from "../hooks/useTrackReorder";
import { useVirtualWindow } from "../hooks/useVirtualWindow";
import { formatTotalDuration } from "../utils/totalDuration";
import type { DropPosition } from "../utils/trackCollectionOrder";
import { TrackArtwork } from "./TrackArtwork";
import { TrackCollectionMenu } from "./TrackCollectionMenu";
import { PerfProfiler } from "./PerfProfiler";
import { VirtualSpacer } from "./VirtualSpacer";
import "./LibraryView.css";
import "./Queue.css";

export type QueueProps = {
  currentEntry: QueueEntry | undefined;
  upcomingEntries: QueueEntry[];
  historyEntries: QueueHistoryEntry[];
  jumpTo: (queueId: QueueId) => void;
  replayHistory: (historyId: string) => void;
  reorderEntries: (queueIds: QueueId[]) => void;
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
type RowAction = "play" | "select" | "menu";
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
  const upcomingIds = useMemo(() => upcoming.map(entry => entry.id), [upcoming]);
  const selection = useRangeSelection(ids);
  const [menu, setMenu] = useState<{ entry: DisplayEntry; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const followCurrent = useRef(true);
  const [awayFromCurrent, setAwayFromCurrent] = useState(false);
  const setScrollElement = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    props.registerScrollElement(element);
  }, [props.registerScrollElement]);
  const currentScrollTop = useCallback(() => {
    const scroller = scrollRef.current;
    const anchor = currentRef.current;
    if (!scroller || !anchor) return 0;
    return Math.max(0, anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      + scroller.scrollTop - (columnsRef.current?.getBoundingClientRect().height ?? 0));
  }, []);
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
  useEffect(() => {
    const resize = () => { if (followCurrent.current) jumpToCurrent(); };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [jumpToCurrent]);

  function trackScrollPosition() {
    const away = Math.abs((scrollRef.current?.scrollTop ?? 0) - currentScrollTop()) > 24;
    followCurrent.current = !away;
    setAwayFromCurrent(away);
  }

  function showHistory() {
    followCurrent.current = false;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setAwayFromCurrent(Boolean(current));
  }
  const reorder = useCallback((orderedIds: string[]) => {
    const entriesById = new Map(upcoming.map(entry => [entry.id, entry.queueId!]));
    if (orderedIds.some(id => !entriesById.has(id))) return;
    props.reorderEntries(orderedIds.map(id => entriesById.get(id)!));
  }, [upcoming, props.reorderEntries]);
  const { draggedTrackId, dropTarget, suppressClick, onPointerDown } = useTrackReorder(
    upcomingIds, reorder, () => setMenu(null), scrollRef,
  );
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
    if (suppressClick.current && !entry.historyId && !entry.current && action !== "select") return;
    if (action === "select" || selection.isSelecting) {
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      selection.toggle(ids.indexOf(entry.id), event.shiftKey);
    } else if (action === "menu") {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      const trigger = event.currentTarget.hasAttribute("data-collection-menu-trigger");
      setMenu({ entry, x: trigger ? rect.right - 180 : event.clientX, y: trigger ? rect.bottom + 4 : event.clientY });
    } else {
      setMenu(null);
      playEntry(entry);
    }
  };
  const onAction = useCallback<EntryAction>((action, event, entry) => actions.current(action, event, entry), []);
  const rowProps = { selecting: selection.isSelecting, selectedIds: selection.selectedIds, onAction };
  const duration = props.upcomingEntries.reduce((total, entry) => total + entry.track.durationSeconds, 0);

  return (
    <PerfProfiler id="queue">
      {menu && <TrackCollectionMenu trackId={menu.entry.track.globalId} onClose={() => setMenu(null)}
        xPos={menu.x} yPos={menu.y} actions={[
          ...(!menu.entry.current ? [{ label: "Play from here", onSelect: () => playEntry(menu.entry) }] : []),
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
          <nav className="librarySections" aria-label="Queue navigation">
            <button type="button" className="librarySectionButton" disabled={!history.length} onClick={showHistory}>
              History{history.length ? ` (${history.length})` : ""}
            </button>
            {current && awayFromCurrent && <button type="button" className="librarySectionButton" onClick={jumpToCurrent}>Jump to now playing</button>}
            {entries.length > 0 && <button type="button" className="librarySectionButton"
              onClick={() => removeEntries(upcoming.length ? upcoming : entries)}>{upcoming.length ? "Clear upcoming" : "Clear all"}</button>}
          </nav>
          <div className="libraryInfo">
            <span>{upcoming.length} {upcoming.length === 1 ? "song" : "songs"} up next</span>
            {upcoming.length > 0 && <><span className="separator">•</span><span>{formatTotalDuration(duration)}</span></>}
          </div>
        </header>
        <div id="queueList" className="libraryView smoothScroll" ref={setScrollElement} onScroll={trackScrollPosition}>
          <div className="columnInfo" ref={columnsRef}>
            <span className="trackColumn">Track</span><span className="artistColumn">Artist</span>
            <span className="albumColumn">Album</span><span className="durationColumn">Duration</span>
          </div>
          <section id="queueHistory" aria-label="Played tracks">
            <QueueRows entries={history} label="Queue history" {...rowProps} />
          </section>
          <div id="currentQueueTrack" ref={currentRef}>
            {current && <QueueRow entry={current} index={0} {...rowProps} selected={selection.selectedIds.has(current.id)} />}
          </div>
          <section id="upcomingQueueTracks" aria-label="Upcoming tracks">
            <QueueRows entries={upcoming} label="Upcoming queue" {...rowProps} onPointerDown={onPointerDown}
              draggedId={draggedTrackId} dropTarget={dropTarget} />
          </section>
          {!entries.length && <p className="queueEmpty">Queue is empty</p>}
        </div>
      </div>
    </PerfProfiler>
  );
}

type RowProps = {
  selecting: boolean;
  selectedIds: ReadonlySet<string>;
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
        selected={props.selectedIds.has(entry.id)} dragging={entry.id === draggedId}
        dropPosition={dropTarget?.trackId === entry.id ? dropTarget.position : undefined}
      />)}
      {virtual.bottomSpace > 0 && <VirtualSpacer position="bottom" height={virtual.bottomSpace} />}
    </div>
  );
}

const QueueRow = memo(function QueueRow({ entry, index, selecting, selected, onAction, onPointerDown, dragging, dropPosition }: Omit<RowProps, "selectedIds"> & {
  entry: DisplayEntry;
  index: number;
  selected: boolean;
  dragging?: boolean;
  dropPosition?: DropPosition;
}) {
  const seconds = Math.max(0, Math.floor(entry.track.durationSeconds));
  return (
    <div className="libraryItem queueItem" role="listitem" data-virtual-item="" data-track-id={entry.id}
      data-selected={selected ? "true" : undefined} data-selecting={selecting ? "true" : undefined}
      data-current={entry.current ? "true" : undefined} data-reorderable={onPointerDown ? "true" : undefined}
      data-played={entry.played ? "true" : undefined} aria-current={entry.current ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined} data-drop-position={dropPosition} draggable={false}
      onClickCapture={event => { if (selecting) onAction("select", event, entry); }}
      onClick={event => onAction("menu", event, entry)}
      onContextMenu={event => onAction("select", event, entry)}
      onPointerDown={event => onPointerDown?.(event, index)} onDragStart={event => event.preventDefault()}>
      <div className="trackLeading">
        <button type="button" className="trackPlayButton" aria-label={`Play ${entry.track.name}`} disabled={entry.current}
          onClick={event => { event.stopPropagation(); onAction("play", event, entry); }}>
          <img src="/Play.svg" alt="" aria-hidden="true" />
        </button>
        <div className="coverImgContainer"><TrackArtwork track={entry.track} alt={`${entry.track.album} cover`} className="coverImg" draggable={false} /></div>
      </div>
      <span className="trackName queueTrackName">{entry.current && <small className="queueNowPlaying">Now playing</small>}<span title={entry.track.name}>{entry.track.name}</span><small className="queueTrackArtist">{entry.track.artist}</small></span>
      <span className="artistName" title={entry.track.artist}>{entry.track.artist}</span>
      <span className="albumName" title={entry.track.album}>{entry.track.album}</span>
      <span className="trackDuration">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>
      <button type="button" className="trackCollectionMenuTrigger" data-collection-menu-trigger
        aria-label={`${selecting ? selected ? "Deselect" : "Select" : "Actions for"} ${entry.track.name}`}
        onClick={event => onAction("menu", event, entry)}>
        <img src={selecting ? selected ? "/select.svg" : "/noSelect.svg" : "/menu.svg"}
          className={selecting ? "selectionIndicator" : undefined} alt={selecting ? selected ? "Selected" : "Not selected" : "Menu"} />
      </button>
    </div>
  );
});
