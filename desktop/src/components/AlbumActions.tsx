import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Track } from "../types/music";
import { TrackCollectionMenu } from "./TrackCollectionMenu";
import type { EntityAction } from "./EntityView";

type AlbumActionsProps = {
  title: string;
  tracks: Track[];
  /** The album's songs not yet in the library. */
  unsaved: Track[];
  onAction: (action: EntityAction, tracks: Track[]) => void;
  onAddTracks: (tracks: Track[]) => void;
};

/** An album's three-dots menu beside Play, like a playlist's. */
export function AlbumActions({ title, tracks, unsaved, onAction, onAddTracks }: AlbumActionsProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; flipY: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const empty = !tracks.length;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="libraryMoreBtn"
        aria-label={`Options for ${title}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        disabled={empty}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setMenu({ x: bounds.right, y: bounds.bottom, flipY: bounds.top });
        }}
      >
        <img src="/menu.svg" alt="" aria-hidden="true" />
      </button>
      {/* Portaled, so the header's clipped action row can't trap the fixed menu. */}
      {menu && createPortal(
        <TrackCollectionMenu
          trackId=""
          xPos={menu.x}
          yPos={menu.y}
          flipY={menu.flipY}
          onClose={() => { setMenu(null); trigger.current?.focus(); }}
          actions={[
            { label: "Add to Queue", icon: "/add-to-queue.svg", onSelect: () => onAction("queue", tracks) },
            { label: "Play Next", icon: "/play-next.svg", onSelect: () => onAction("nextAll", tracks) },
            {
              label: unsaved.length ? "Add to Library" : "In Library",
              icon: "/add.svg",
              disabled: !unsaved.length,
              onSelect: () => onAddTracks(unsaved),
            },
          ]}
        />,
        document.body,
      )}
    </>
  );
}
