import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { LibrarySection } from "../components/LibraryView";
import type { PlaybackSidebarView } from "../components/PlaybackSidebar";
import type { SearchFocusRequest } from "../components/SearchBar";
import type { SettingsTab } from "../components/SettingsSidebar";
import { entityKey, type BrowseEntity } from "../utils/browse";
import { isTypingTarget, wasKeyHandled } from "../utils/keyboard";
import { isPlayerScreen, type AppPreferences, type AppScreen } from "../utils/preferences";
import { announceShortcut, matchesShortcut, matchingShortcut } from "../utils/shortcuts";
import { usePageNavigation } from "./usePageNavigation";
import { useStableCallback } from "./useStableCallback";

/** Sessions saved before Settings stood apart could return to it; those go to the library instead. */
function withoutSettings<T extends AppScreen>(screen: T): Exclude<T, "settings"> {
  return (screen === "settings" ? "library" : screen) as Exclude<T, "settings">;
}

type AppNavigationOptions = {
  preferences: AppPreferences;
  setPreferences: Dispatch<SetStateAction<AppPreferences>>;
  selectedPlaylistId: string | null;
  setSelectedPlaylistId: Dispatch<SetStateAction<string | null>>;
  hasCurrentTrack: boolean;
  isFullscreen: boolean | null;
  localOnly: boolean;
};

export function useAppNavigation({
  preferences, setPreferences, selectedPlaylistId, setSelectedPlaylistId,
  hasCurrentTrack, isFullscreen, localOnly,
}: AppNavigationOptions) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(preferences.ui.navigation?.settingsTab ?? "general");
  const [browseEntity, setBrowseEntity] = useState<BrowseEntity | null>(preferences.ui.navigation?.entity ?? null);
  const [librarySection, setLibrarySection] = useState<LibrarySection>(preferences.ui.navigation?.section ?? "overview");
  const screen = preferences.ui.screen;
  const isPlayerView = isPlayerScreen(screen);
  // Settings is a separate place, never a page the queue or player sits over or returns to.
  const queueReturnScreenRef = useRef<Exclude<AppScreen, "bigscreen" | "lyrics" | "queue" | "settings">>(
    withoutSettings(preferences.ui.navigation?.queueReturnScreen ?? (screen === "home" || screen === "search" ? screen : "library")),
  );
  const playerReturnScreenRef = useRef<Exclude<AppScreen, "bigscreen" | "lyrics" | "settings">>(
    withoutSettings(preferences.ui.navigation?.playerReturnScreen ?? "library"),
  );
  if (!isPlayerView && screen !== "settings") playerReturnScreenRef.current = screen;
  const playerOpenedByKeyRef = useRef(false);
  // While the player is open, the screen hidden behind it keeps what it showed.
  const libraryScreen = isPlayerView ? playerReturnScreenRef.current : screen;
  const isQueueView = libraryScreen === "queue";
  const isSettingsView = libraryScreen === "settings";
  const [playbackSidebarView, setPlaybackSidebarView] = useState<PlaybackSidebarView | null>(null);
  const canShowPlaybackSidebar = isFullscreen !== true && !isPlayerView && !isQueueView;
  const sidebarView = canShowPlaybackSidebar ? playbackSidebarView : null;
  const closePlaybackSidebar = useCallback(() => {
    if (document.activeElement?.closest("#playbackSidebar")) document.getElementById("queueBtn")?.focus();
    setPlaybackSidebarView(null);
  }, []);
  const isHomeView = libraryScreen === "home" && !browseEntity;
  const isSearchView = libraryScreen === "search" && !browseEntity;
  if (screen === "home" || screen === "library" || screen === "search") {
    queueReturnScreenRef.current = screen;
  }
  // Page history restores content; retain player/queue overlays and their return screens too.
  const settingsReturnRef = useRef<{
    screen: AppScreen;
    playerReturnScreen: typeof playerReturnScreenRef.current;
    queueReturnScreen: typeof queueReturnScreenRef.current;
  } | null>(null);
  const { back: goBack, forward: goForward, canGo: canGoInHistory } = usePageNavigation({
    screen: libraryScreen === "queue" ? queueReturnScreenRef.current : libraryScreen,
    entity: browseEntity, playlistId: selectedPlaylistId, section: librarySection,
    settingsTab, search: preferences.search,
  }, page => {
    setBrowseEntity(page.entity);
    setSelectedPlaylistId(page.playlistId);
    setLibrarySection(page.section);
    setSettingsTab(page.settingsTab);
    setPreferences(current => ({ ...current, search: page.search, ui: { ...current.ui, screen: page.screen } }));
  });
  // Re-save after local-only mode changes because persistence can now target a different source.
  const sessionPreferences = useMemo(() => ({
    ...preferences,
    ui: {
      ...preferences.ui,
      navigation: {
        playerReturnScreen: playerReturnScreenRef.current,
        queueReturnScreen: queueReturnScreenRef.current,
        entity: browseEntity,
        playlistId: selectedPlaylistId,
        section: librarySection,
        settingsTab,
      },
    },
  }), [preferences, localOnly, browseEntity, selectedPlaylistId, librarySection, settingsTab]);

  const changeScreen = useStableCallback((nextScreen: AppScreen) => {
    if (isPlayerScreen(nextScreen) && !isPlayerView && !hasCurrentTrack) return;
    setPreferences((current) => ({
      ...current,
      ui: {
        ...current.ui,
        screen: nextScreen,
      },
    }));
  });

  // Player views and queue return to the page where they were opened.
  const returnScreen = (from: AppScreen) => isPlayerScreen(from)
    ? playerReturnScreenRef.current
    : from === "queue" ? queueReturnScreenRef.current : "library";
  const leaveScreen = useStableCallback(() => setPreferences(current => ({
    ...current, ui: { ...current.ui, screen: returnScreen(current.ui.screen) },
  })));
  const openEntity = useStableCallback((entity: BrowseEntity) => {
    if (browseEntity && entityKey(entity) === entityKey(browseEntity) && !isPlayerView && screen !== "queue") return;
    setBrowseEntity(entity);
    setSelectedPlaylistId(null);
    changeScreen("library");
  });

  const openHome = useStableCallback(() => {
    setBrowseEntity(null);
    setSelectedPlaylistId(null);
    changeScreen("home");
  });
  const openLibrarySection = useStableCallback((section: LibrarySection) => {
    setBrowseEntity(null);
    setSelectedPlaylistId(null);
    setLibrarySection(section);
    changeScreen("library");
  });
  const selectPlaylist = useStableCallback((id: string) => {
    setBrowseEntity(null);
    setSelectedPlaylistId(id);
    changeScreen("library");
  });

  // Settings and the player have no search of their own; Cmd/Ctrl+F summons the bar over them.
  const hasSearchPage = !isPlayerView && !isSettingsView;
  const [searchSummon, setSearchSummon] = useState<"off" | "on" | "dismissed">("off");
  useEffect(() => setSearchSummon("off"), [screen]);
  const [searchFocus, setSearchFocus] = useState<SearchFocusRequest | null>(null);
  const requestSearchFocus = (caret: SearchFocusRequest["caret"]) =>
    setSearchFocus((current) => ({ id: (current?.id ?? 0) + 1, caret }));

  const changeSearchQuery = (nextQuery: string) => {
    // A blank query on a page without search leaves the listener where they are.
    if (!nextQuery.trim() && !hasSearchPage) {
      setPreferences((current) => ({ ...current, search: { ...current.search, query: nextQuery } }));
      return;
    }
    setBrowseEntity(null);
    setPreferences((current) => ({
      ...current,
      ui: {
        ...current.ui,
        screen: nextQuery.trim() ? "search" : "library",
      },
      search: {
        ...current.search,
        query: nextQuery,
      },
    }));
  };

  const confirmSearch = () => {
    if (preferences.search.query.trim()) {
      setBrowseEntity(null);
      changeScreen("search");
    } else if (hasSearchPage) {
      changeScreen("library");
    }
  };
  const dismissSearch = () => setSearchSummon(summon => summon === "on" ? "dismissed" : summon);

  /** Restores the page Settings was opened over; returns the screen to show, if goBack didn't settle it. */
  const leaveSettings = (): AppScreen | null => {
    const origin = settingsReturnRef.current;
    settingsReturnRef.current = null;
    const restored = goBack();
    if (origin) {
      playerReturnScreenRef.current = origin.playerReturnScreen;
      queueReturnScreenRef.current = origin.queueReturnScreen;
      // A player opened over nothing playing can't come back once the song is gone.
      const playerGone = isPlayerScreen(origin.screen) && !hasCurrentTrack;
      return playerGone ? origin.playerReturnScreen : origin.screen;
    }
    return restored ? null : "library";
  };

  const closeCurrentScreen = useStableCallback(() => {
    if (screen === "settings") {
      const target = leaveSettings();
      if (target) changeScreen(target);
      return;
    }
    if (browseEntity && !isPlayerView && screen !== "queue") { goBack(); return; }
    changeScreen(returnScreen(screen));
  });

  // The full queue and player replace Settings.
  const openQueue = useStableCallback(() => {
    if (screen === "settings") leaveSettings();
    changeScreen("queue");
  });
  const toggleQueue = useStableCallback(() => {
    if (sidebarView) closePlaybackSidebar();
    else if (canShowPlaybackSidebar) setPlaybackSidebarView("queue");
    else if (screen === "queue") closeCurrentScreen();
    else openQueue();
  });
  const openPlayer = useStableCallback(() => {
    if (!hasCurrentTrack) return;
    if (screen === "settings") leaveSettings();
    changeScreen(preferences.ui.playerView);
  });
  const toggleBigscreen = useStableCallback(() => {
    if (isPlayerView) {
      changeScreen(playerReturnScreenRef.current);
    } else {
      // Opened from the keyboard, the player starts with its extra controls already put away.
      playerOpenedByKeyRef.current = hasCurrentTrack;
      openPlayer();
      // Without a song the player stays shut, so say why.
      if (!hasCurrentTrack) announceShortcut("Nothing is playing");
    }
  });
  const openSettings = useStableCallback(() => {
    if (screen === "settings") return;
    settingsReturnRef.current = {
      screen,
      playerReturnScreen: playerReturnScreenRef.current,
      queueReturnScreen: queueReturnScreenRef.current,
    };
    setBrowseEntity(null);
    setSelectedPlaylistId(null);
    changeScreen("settings");
  });

  const canNavigate = useStableCallback((direction: "back" | "forward") => {
    if (document.querySelector("dialog[open], #trackMenuBackdrop, [data-click-menu-backdrop], .columnPickerMenu")) return false;
    if (screen === "settings" && direction === "back") return true;
    if (isPlayerView || screen === "queue") return direction === "back";
    return canGoInHistory(direction);
  });
  const navigate = useStableCallback((direction: "back" | "forward") => {
    if (!canNavigate(direction)) return false;
    if (screen === "settings" && direction === "back") {
      closeCurrentScreen();
      return true;
    }
    if (isPlayerView || screen === "queue") {
      leaveScreen();
      return true;
    }
    return direction === "back" ? goBack() : goForward();
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (wasKeyHandled(event) || !matchesShortcut(event, "closeScreen")) return;
      // Dialogs keep their native Escape dismissal; elsewhere it must not leave fullscreen.
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      // Let search, menus, and playlist dialogs handle their own Escape.
      if (document.querySelector("#trackMenuBackdrop, [data-click-menu-backdrop]")
        || (event.target instanceof Element && event.target.closest("#searchBar")))
        return;
      if (sidebarView && !isTypingTarget(event.target)) {
        if (!event.repeat) closePlaybackSidebar();
        return;
      }
      // Settings is a place you visit rather than a page of its own, so Escape returns from it too.
      if (screen === "settings") {
        // A text field in settings keeps Escape for itself.
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        if (!event.repeat) closeCurrentScreen();
        return;
      }
      if (!isPlayerView && screen !== "queue") return;
      event.preventDefault();
      event.stopPropagation();

      if (event.repeat) return;
      leaveScreen();
    };

    const handleNavigationKey = (event: KeyboardEvent) => {
      const direction = matchingShortcut(event, ["back", "forward"] as const);
      if (!direction || wasKeyHandled(event)) return;
      event.preventDefault();
      if (!event.repeat) navigate(direction);
    };
    const handleMouseNavigation = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.type === "mouseup") navigate(event.button === 3 ? "back" : "forward");
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keydown", handleNavigationKey, true);
    window.addEventListener("mousedown", handleMouseNavigation, true);
    window.addEventListener("mouseup", handleMouseNavigation, true);
    window.addEventListener("auxclick", handleMouseNavigation, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keydown", handleNavigationKey, true);
      window.removeEventListener("mousedown", handleMouseNavigation, true);
      window.removeEventListener("mouseup", handleMouseNavigation, true);
      window.removeEventListener("auxclick", handleMouseNavigation, true);
    };
  }, [screen, navigate, sidebarView, closePlaybackSidebar, closeCurrentScreen, leaveScreen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, "togglePlayer")) return;
      if (
        isTypingTarget(event.target) ||
        (event.target instanceof Element &&
        event.target.closest("#searchBar"))
      ) {
        return;
      }

      if (event.repeat) return;

      if (!isTauri()) {
        event.preventDefault();
        event.stopPropagation();
        toggleBigscreen();
        return;
      }

      void invoke<boolean>("native_function_modifier_pressed").then((functionPressed) => {
        if (functionPressed) return;
        toggleBigscreen();
      });
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [toggleBigscreen]);

  useEffect(() => {
    if (isPlayerScreen(screen) && preferences.ui.playerView !== screen)
      setPreferences((current) => ({ ...current, ui: { ...current.ui, playerView: screen } }));
  }, [screen, preferences.ui.playerView]);

  // Cmd/Ctrl+F opens Ambra's search everywhere, in place of the WebView's find bar.
  const openSearch = useStableCallback(() => {
    if (localOnly) return;
    if (!hasSearchPage) setSearchSummon("on");
    requestSearchFocus("select");
  });
  // Search opens only through its shortcut; typing elsewhere in the app never starts one.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, "search")) return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openSearch]);

  // Q toggles the queue; Cmd/Ctrl+comma opens settings.
  const handleScreenShortcut = useStableCallback((event: KeyboardEvent) => {
    if (wasKeyHandled(event) || event.repeat) return;
    if (matchesShortcut(event, "openSettings")) {
      event.preventDefault();
      if (!isSettingsView) openSettings();
    } else if (matchesShortcut(event, "toggleQueue") && !isTypingTarget(event.target)) {
      event.preventDefault();
      toggleQueue();
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", handleScreenShortcut);
    return () => window.removeEventListener("keydown", handleScreenShortcut);
  }, [handleScreenShortcut]);

  return {
    screen, isPlayerView, isQueueView, isSettingsView, isHomeView, isSearchView,
    browseEntity, librarySection, setLibrarySection, settingsTab, setSettingsTab,
    sidebarView, canShowPlaybackSidebar, setPlaybackSidebarView, closePlaybackSidebar,
    sessionPreferences, goBack, canNavigate, navigate, closeCurrentScreen, changeScreen,
    openEntity, openHome, openLibrarySection, selectPlaylist, openSettings, openQueue, toggleQueue,
    openPlayer, playerOpenedByKeyRef, hasSearchPage, searchSummon, searchFocus, changeSearchQuery,
    confirmSearch, dismissSearch,
  };
}
