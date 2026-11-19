import { useMemo, useRef, useState, type ReactNode } from "react";
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
  onChangeView: (view: PlaybackSidebarView) => void;
  onClose: () => void;
  lyrics: ReactNode;
  recent: ListeningEntry[];
  recentError: string | null;
  onPlayRecent: (track: Track) => void;
};

export function PlaybackSidebar({
  view, onChangeView, onClose, lyrics, recent, recentError, onPlayRecent, ...queue
}: PlaybackSidebarProps) {
  return (
    <aside className="playbackSidebar" id="playbackSidebar" aria-label="Playback sidebar"
      onKeyDown={event => { if (event.key === " " && event.target instanceof HTMLButtonElement) event.stopPropagation(); }}>
      <header className="playbackSidebarHeader">
        <div className="playbackSidebarViews" role="group" aria-label="Playback sidebar view">
          {views.map(({ id, label }) => (
            <button key={id} type="button" aria-pressed={view === id} onClick={() => onChangeView(id)}>{label}</button>
          ))}
        </div>
        <button type="button" className="playbackSidebarIcon" aria-label="Close playback sidebar" onClick={onClose}>
          <img src="/x.svg" alt="" />
        </button>
      </header>
      {view === "queue" && <SidebarQueue {...queue} />}
      {view === "lyrics" && lyrics}
      {view === "recent" && <RecentlyPlayed entries={recent} error={recentError} onPlay={onPlayRecent} />}
    </aside>
  );
}

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
          <h2 id="playbackSidebarNowPlaying">Now playing</h2>
          <div className="playbackSidebarRow" aria-current="true"><SidebarTrack track={currentTrack} /></div>
        </section>}
        <section aria-labelledby="playbackSidebarUpNext">
          <div className="playbackSidebarSectionHeader">
            <h2 id="playbackSidebarUpNext">Up next</h2>
            <button className="playbackSidebarTextButton" type="button" onClick={onOpenFullQueue}>Full queue</button>
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
    fallback: { rowHeight: 50 }, cacheKey: `playback-sidebar:${label}`, pinnedIndex,
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
