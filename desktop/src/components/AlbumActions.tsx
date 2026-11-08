import { useRef, useState } from "react";
import type { Track } from "../types/music";
import type { EntityAction } from "./EntityView";
import { AlbumMenu } from "./AlbumMenu";
import type { PlaylistMenuOptions } from "./TrackCollectionMenu";

type AlbumActionsProps = {
  title: string;
  tracks: Track[];
  savedTrackIds: ReadonlySet<string>;
  onAction: (action: EntityAction, tracks: Track[]) => void;
  onAddTracks: (tracks: Track[]) => void;
  playlistOptions?: PlaylistMenuOptions;
};

/** An album's three-dots menu beside Play, like a playlist's. */
export function AlbumActions({ title, tracks, savedTrackIds, onAction, onAddTracks, playlistOptions }: AlbumActionsProps) {
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
      {menu && (
        <AlbumMenu
          title={title}
          tracks={tracks}
          savedTrackIds={savedTrackIds}
          onAction={onAction}
          onAddTracks={onAddTracks}
          playlistOptions={playlistOptions}
          xPos={menu.x}
          yPos={menu.y}
          flipY={menu.flipY}
          onClose={() => { setMenu(null); trigger.current?.focus(); }}
        />
      )}
    </>
  );
}
