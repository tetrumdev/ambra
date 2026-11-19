import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ListeningEntry } from "../hooks/useListeningHistory";
import { isTrackAvailable, useServiceAvailability } from "../hooks/useServiceAvailability";
import { useTrackReorder } from "../hooks/useTrackReorder";
import { useVirtualWindow } from "../hooks/useVirtualWindow";
import type { QueueEntry, QueueId, Track } from "../types/music";
import { queueEntryKey } from "../utils/queueNavigation";
import { trackArtistNames } from "../utils/trackArtists";
import { MENU_WIDTH } from "../utils/trackMenu";
import { TrackArtwork } from "./TrackArtwork";
import { TrackCollectionMenu } from "./TrackCollectionMenu";
import { VirtualSpacer } from "./VirtualSpacer";
import "./PlaybackSidebar.css";

const views = [
  { id: "queue", label: "Queue" },
  { id: "lyrics", label: "Lyrics" },
  { id: "recent", label: "Recently played" },
] as const;

export type PlaybackSidebarView = typeof views[number]["id"];

type SidebarQueueProps = {
  currentTrack: Track | undefined;
  upcoming: QueueEntry[];
  onJumpTo: (id: QueueId) => void;
  onRemove: (ids: QueueId[]) => void;
  onReorder: (ids: QueueId[]) => void;
  onOpenFullQueue: () => void;
};

type PlaybackSidebarProps = SidebarQueueProps & {
  view: PlaybackSidebarView;
  preferredWidth: RefObject<number | null>;
  onChangeView: (view: PlaybackSidebarView) => void;
  onClose: () => void;
  lyrics: ReactNode;
  recent: ListeningEntry[];
  recentError: string | null;
  onPlayRecent: (track: Track) => void;
};

export function PlaybackSidebar({
  view, preferredWidth, onChangeView, onClose, lyrics, recent, recentError, onPlayRecent, ...queue
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
      {view === "queue" && <SidebarQueue {...queue} />}
      {view === "lyrics" && lyrics}
      {view === "recent" && <RecentlyPlayed entries={recent} error={recentError} onPlay={onPlayRecent} />}
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

function SidebarQueue({ currentTrack, upcoming, onJumpTo, onRemove, onReorder, onOpenFullQueue }: SidebarQueueProps) {
  const connected = useServiceAvailability();
  const scroller = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLButtonElement } | null>(null);
  const ids = useMemo(() => upcoming.map(queueEntryKey), [upcoming]);
  const reorder = (ordered: string[]) => {
    if (ordered.every((id, index) => id === ids[index])) return;
    const positions = new Map(ids.map((id, index) => [id, upcoming[index].queueId]));
    onReorder(ordered.map(id => positions.get(id)!));
  };
  const { draggedTrackId, dropTarget, onPointerDown } = useTrackReorder(ids, reorder, () => setMenu(null), scroller);
  const menuIndex = menu ? ids.indexOf(menu.id) : -1;
  if (menu && menuIndex < 0) setMenu(null);
  const menuEntry = upcoming[menuIndex];
  const anchor = menuEntry && menu?.anchor.getBoundingClientRect();
  return (
    <>
      {menu && menuEntry && anchor && <TrackCollectionMenu
        trackId={menuEntry.track.globalId}
        xPos={anchor.right - MENU_WIDTH} yPos={anchor.bottom + 4} flipY={anchor.top - 4}
        onClose={() => { setMenu(null); menu.anchor.focus(); }}
        actions={[
          { label: "Play from here", icon: "/play.svg", disabled: !isTrackAvailable(menuEntry.track, connected),
            onSelect: () => onJumpTo(menuEntry.queueId) },
          { label: "Move to front", icon: "/play-next.svg", whenUnavailable: true, disabled: menuIndex === 0,
            onSelect: () => reorder([menu.id, ...ids.filter(id => id !== menu.id)]) },
          { label: "Remove from queue", icon: "/delete.svg", whenUnavailable: true, onSelect: () => onRemove([menuEntry.queueId]) },
        ]}
      />}
      <div className="playbackSidebarScroll" ref={scroller}>
        {currentTrack && <section aria-labelledby="playbackSidebarNowPlaying">
          <h2 className="queueSectionTitle" id="playbackSidebarNowPlaying">Now playing</h2>
          <div className="playbackSidebarRow" aria-current="true"><SidebarTrack track={currentTrack} /></div>
        </section>}
        <section aria-labelledby="playbackSidebarUpNext">
          <div className="playbackSidebarSectionHeader">
            <h2 className="queueSectionTitle" id="playbackSidebarUpNext">Up next</h2>
            <button className="queueTextButton playbackSidebarTextButton" type="button" onClick={onOpenFullQueue}>Full queue</button>
          </div>
          {upcoming.length ? <SidebarTrackList
            count={upcoming.length} label="Upcoming tracks" pinnedIndex={draggedTrackId ? ids.indexOf(draggedTrackId) : null}
            renderRow={index => {
              const entry = upcoming[index];
              const id = ids[index];
              return (
                <div className="playbackSidebarRow" role="listitem" key={id} data-virtual-item="" data-track-id={id}
                  data-dragging={draggedTrackId === id || undefined}
                  data-drop-position={dropTarget?.trackId === id ? dropTarget.position : undefined}
                  onPointerDown={event => onPointerDown(event, index)}>
                  <SidebarTrack track={entry.track} onPlay={() => onJumpTo(entry.queueId)} disabled={!isTrackAvailable(entry.track, connected)} />
                  <span className="playbackSidebarGrip" aria-hidden="true" />
                  <button type="button" className="playbackSidebarIcon" aria-label={`Queue options for ${entry.track.name}`}
                    aria-expanded={menuIndex === index} onClick={event => setMenu({ id, anchor: event.currentTarget })}>
                    <img src="/menu.svg" alt="" />
                  </button>
                </div>
              );
            }}
          /> : <p className="playbackSidebarMessage">Nothing up next.</p>}
        </section>
      </div>
    </>
  );
}

function RecentlyPlayed({ entries, error, onPlay }: { entries: ListeningEntry[]; error: string | null; onPlay: (track: Track) => void }) {
  const connected = useServiceAvailability();
  const recent = useMemo(() => [...entries].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt), [entries]);
  return (
    <div className="playbackSidebarScroll">
      {error && <p className="playbackSidebarMessage" role="alert">{error}</p>}
      {recent.length > 0 ? <SidebarTrackList count={recent.length} label="Recently played tracks"
        renderRow={index => {
          const { track } = recent[index];
          return (
            <div key={track.globalId} className="playbackSidebarRow" role="listitem" data-virtual-item="">
              <SidebarTrack track={track} onPlay={() => onPlay(track)} disabled={!isTrackAvailable(track, connected)} />
            </div>
          );
        }}
      /> : !error && <p className="playbackSidebarMessage">Play a song to start your listening history.</p>}
    </div>
  );
}

function SidebarTrackList({ count, label, pinnedIndex, renderRow }: {
  count: number;
  label: string;
  pinnedIndex?: number | null;
  renderRow: (index: number) => ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const virtual = useVirtualWindow({
    count, enabled: count > 120, probeRef: list, probeIsContainer: true,
    fallback: { rowHeight: TRACK_ROW_HEIGHT }, cacheKey: `playback-sidebar:${label}`, pinnedIndex,
  });
  return (
    <div role="list" aria-label={label} ref={list}>
      {virtual.topSpace > 0 && <VirtualSpacer position="top" height={virtual.topSpace} />}
      {Array.from({ length: Math.min(virtual.end, count) - virtual.start }, (_, index) => renderRow(virtual.start + index))}
      {virtual.bottomSpace > 0 && <VirtualSpacer position="bottom" height={virtual.bottomSpace} />}
    </div>
  );
}

function SidebarTrack({ track, onPlay, disabled }: { track: Track; onPlay?: () => void; disabled?: boolean }) {
  const content = (
    <>
      <span className="playbackSidebarArtwork">
        <TrackArtwork track={track} alt="" draggable={false} />
        {onPlay && <img className="playbackSidebarPlay" src="/play.svg" alt="" />}
      </span>
      <span className="playbackSidebarTrackText">
        <span title={track.name}>{track.name}</span>
        <small>{trackArtistNames(track)}</small>
      </span>
    </>
  );
  return onPlay
    ? <button className="playbackSidebarTrack" type="button" aria-label={`Play ${track.name}`} disabled={disabled} onClick={onPlay}>{content}</button>
    : <div className="playbackSidebarTrack">{content}</div>;
}
