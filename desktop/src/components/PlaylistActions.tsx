import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Playlist } from "../types/music";
import { TrackCollectionMenu, type TrackCollectionAction } from "./TrackCollectionMenu";
import { closeDialog, openDialog } from "../utils/dialogs";

type Props = {
  playlist: Playlist;
  onRename?: (id: string, name: string) => boolean;
  onDelete?: (id: string) => boolean;
  /** Listed between Rename and Delete. */
  actions?: TrackCollectionAction[];
  className?: string;
  children?: ReactNode;
};

export function PlaylistActions({ playlist, onRename, onDelete, actions = [], className = "sidebarPlaylistActions", children }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [action, setAction] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState(playlist.name);
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (action) openDialog(dialog.current);
    else closeDialog(dialog.current);
  }, [action]);

  function close() {
    setAction(null);
    trigger.current?.focus();
  }

  function edit(next: "rename" | "delete") {
    setName(playlist.name);
    setError(false);
    setAction(next);
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-label={`Options for ${playlist.name}`}
        aria-haspopup="dialog"
        aria-expanded={Boolean(menu)}
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setMenu({ x: bounds.right, y: bounds.bottom });
        }}
      >
        {children ?? <span aria-hidden="true">⋯</span>}
      </button>
      {/* Portaled: the playlist header's transformed, clipped action row would trap a fixed menu. */}
      {menu && createPortal(
        <TrackCollectionMenu
          trackId=""
          xPos={menu.x}
          yPos={menu.y}
          onClose={() => {
            setMenu(null);
            trigger.current?.focus();
          }}
          actions={[
            ...(onRename ? [{ label: "Rename Playlist", onSelect: () => edit("rename") }] : []),
            ...actions,
            ...(onDelete ? [{ label: "Delete Playlist", onSelect: () => edit("delete") }] : []),
          ]}
        />,
        document.body,
      )}
      <dialog
        ref={dialog}
        className="playlistEditDialog"
        aria-label={action === "rename" ? "Rename playlist" : "Delete playlist"}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="playlistEditCancel"
          autoFocus={action === "delete"}
          onClick={close}
        >
          Cancel
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const saved =
              action === "rename"
                ? onRename?.(playlist.id, name)
                : onDelete?.(playlist.id);
            if (saved) close();
            else setError(true);
          }}
        >
          <div className="playlistEditContent">
            <h2>
              {action === "rename" ? "Rename playlist" : "Delete playlist?"}
            </h2>
            {action === "rename" ? (
              <input
                spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
                autoFocus
                aria-label="Playlist name"
                value={name}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setName(event.target.value)}
              />
            ) : (
              <p>Delete “{playlist.name}”?</p>
            )}
            {error && (
              <p role="alert">Could not save this change. Please try again.</p>
            )}
          </div>
          <div className="playlistEditButtons">
            <button
              type="submit"
              disabled={action === "rename" && !name.trim()}
            >
              {action === "rename" ? "Save" : "Delete"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
