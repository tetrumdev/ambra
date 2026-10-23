import { useLayoutEffect, useRef } from "react";
import type { LibrarySection } from "../components/LibraryView";
import type { SettingsTab } from "../components/SettingsSidebar";
import { entityKey, type BrowseEntity } from "../utils/browse";
import type { AppPreferences, AppScreen } from "../utils/preferences";
import { useStableCallback } from "./useStableCallback";

export type AppPage = {
  screen: Exclude<AppScreen, "bigscreen" | "lyrics" | "queue">;
  entity: BrowseEntity | null;
  playlistId: string | null;
  section: LibrarySection;
  settingsTab: SettingsTab;
  search: AppPreferences["search"];
};

function pageKey(page: AppPage) {
  if (page.screen === "settings") return `settings:${page.settingsTab}`;
  if (page.entity) return entityKey(page.entity);
  if (page.screen !== "library") return page.screen;
  return page.playlistId ? `playlist:${page.playlistId}` : `library:${page.section}`;
}

/** Track committed pages, keeping overlays out of history and edits within the current page. */
export function usePageNavigation(page: AppPage, restore: (page: AppPage) => void) {
  const history = useRef({ back: [] as AppPage[], current: page, forward: [] as AppPage[] });
  useLayoutEffect(() => {
    const state = history.current;
    if (pageKey(state.current) !== pageKey(page)) {
      state.back.push(state.current);
      if (state.back.length > 100) state.back.shift();
      state.forward = [];
    }
    state.current = page;
  });

  /** False when there's no page in that direction. */
  const move = useStableCallback((direction: "back" | "forward") => {
    const state = history.current;
    const target = state[direction].pop();
    if (!target) return false;
    state[direction === "back" ? "forward" : "back"].push(state.current);
    state.current = target;
    restore(target);
    return true;
  });
  const back = useStableCallback(() => move("back"));
  const forward = useStableCallback(() => move("forward"));
  const canGo = useStableCallback((direction: "back" | "forward") => history.current[direction].length > 0);
  return { back, forward, canGo };
}
