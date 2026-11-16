import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "../hooks/useStableCallback";
import { announceShortcut } from "../utils/shortcuts";
import "./MusicDropZone.css";

const AUDIO = /\.(mp3|m4a|mp4|flac|ogg|opus|wav|aiff?)$/i;

/** Folders have no extension; anything else must be audio the library can read. */
const acceptable = (paths: string[]) => paths.some(path => AUDIO.test(path) || !/\.[^\\/.]+$/.test(path));

/** Audio files or folders dragged over the window are added to the library when dropped. */
export function MusicDropZone({ onImport }: { onImport: (paths: string[]) => Promise<number> }) {
  const [over, setOver] = useState(false);
  const accepting = useRef(false);
  const importPaths = useStableCallback(async (paths: string[]) => {
    announceShortcut("Adding to library…");
    try {
      const count = await onImport(paths);
      announceShortcut(count ? `Added ${count} ${count === 1 ? "song" : "songs"} to library` : "No playable audio found");
    } catch (reason) {
      console.error("Could not add dropped music:", reason);
      announceShortcut("Could not add music");
    }
  });

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter") {
        accepting.current = acceptable(payload.paths);
        setOver(accepting.current);
      } else if (payload.type === "leave") {
        setOver(false);
      } else if (payload.type === "drop") {
        setOver(false);
        if (accepting.current && acceptable(payload.paths)) void importPaths(payload.paths);
      }
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }).catch(() => {});
    return () => { disposed = true; stop?.(); };
  }, [importPaths]);

  return <div className="musicDropZone" data-shown={over ? "true" : undefined} aria-hidden={!over}>
    <div className="musicDropZoneBody">Drop to add to your library</div>
  </div>;
}
