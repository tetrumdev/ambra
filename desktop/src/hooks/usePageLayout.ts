import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { acceptsPlaybackShortcut } from "../utils/keyboard";
import { actOnCursor, flashItem, installPointerCursor, moveCursor, moveSidebar, SIDEBAR_ROOT } from "../utils/keyboardNav";
import { announceShortcut, matchesShortcut, matchingShortcut } from "../utils/shortcuts";
import { enterView } from "../utils/viewMotion";
import { useStableCallback } from "./useStableCallback";

/** Restores scroll and owns the interactions shared by the mounted workspace pages. */
export function usePageLayout(viewKey: string, isPlayerView: boolean) {
  const mainRef = useRef<HTMLElement>(null);
  const [activeScrollElement, setActiveScrollElement] =
    useState<HTMLDivElement | null>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const registeredScrollElementRef = useRef<HTMLDivElement | null>(null);
  const restoreScrollFrameRef = useRef<number | null>(null);

  const registerScrollElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (restoreScrollFrameRef.current !== null) {
        cancelAnimationFrame(restoreScrollFrameRef.current);
        restoreScrollFrameRef.current = null;
      }

      if (element === null) {
        const registeredElement = registeredScrollElementRef.current;
        if (registeredElement) {
          scrollPositionsRef.current.set(
            viewKey,
            registeredElement.scrollTop,
          );
          registeredScrollElementRef.current = null;
        }
        setActiveScrollElement(null);
        return;
      }

      registeredScrollElementRef.current = element;
      const savedPosition = scrollPositionsRef.current.get(viewKey) ?? 0;
      element.scrollTop = savedPosition;
      setActiveScrollElement(element);
      restoreScrollFrameRef.current = requestAnimationFrame(() => {
        if (registeredScrollElementRef.current === element) {
          element.scrollTop = savedPosition;
        }
        restoreScrollFrameRef.current = null;
      });
    },
    [viewKey],
  );

  useEffect(() => {
    const disableContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    const disableNativeDrag = (event: DragEvent) => {
      event.preventDefault();
    };

    const resetHorizontalScroll = () => {
      document.scrollingElement?.scrollTo({ left: 0 });
      for (const element of document.querySelectorAll<HTMLElement>(
        "#library, #search, #queue, .libraryView, .searchView, #queueList",
      )) {
        if (element.scrollLeft !== 0) element.scrollLeft = 0;
      }
    };

    const keepDragVertical = (event: PointerEvent) => {
      if (event.buttons !== 0) resetHorizontalScroll();
    };

    window.addEventListener("contextmenu", disableContextMenu, true);
    window.addEventListener("dragstart", disableNativeDrag, true);
    window.addEventListener("scroll", resetHorizontalScroll, true);
    window.addEventListener("pointermove", keepDragVertical, true);
    return () => {
      window.removeEventListener("contextmenu", disableContextMenu, true);
      window.removeEventListener("dragstart", disableNativeDrag, true);
      window.removeEventListener("scroll", resetHorizontalScroll, true);
      window.removeEventListener("pointermove", keepDragVertical, true);
    };
  }, []);

  // The page's lists and the sidebar, item by item (utils/keyboardNav.ts). Captured first, so a
  // key that moves through a list doesn't also seek or change the volume.
  const handleListShortcut = useStableCallback((event: KeyboardEvent) => {
    if (isPlayerView || !acceptsPlaybackShortcut(event, true)) return;
    const id = matchingShortcut(event, [
      "listNext", "listPrevious", "listFirst", "listLast", "playSelected", "addSelectedToQueue", "playSelectedNext",
      "sidebarNext", "sidebarPrevious",
    ] as const);
    if (!id) return;
    const main = mainRef.current;
    const focused = document.activeElement;
    if (focused?.closest("#playbackSidebar")) return;
    const inSidebar = focused instanceof Element && focused.closest(SIDEBAR_ROOT) !== null;
    // The sidebar is a list too: once it has the keyboard, the list keys move through it.
    const sidebarStep = id === "sidebarNext" || (inSidebar && id === "listNext") ? 1
      : id === "sidebarPrevious" || (inSidebar && id === "listPrevious") ? -1 : 0;
    if (sidebarStep) {
      if (moveSidebar(main, sidebarStep)) event.preventDefault();
      return;
    }
    if (inSidebar) return;
    if (id === "listNext" || id === "listPrevious" || id === "listFirst" || id === "listLast") {
      const move = id === "listNext" ? 1 : id === "listPrevious" ? -1 : id === "listFirst" ? "first" : "last";
      // A page without a list keeps the key, so it scrolls as usual.
      if (moveCursor(main, move)) event.preventDefault();
      return;
    }
    // A focused control other than the selected item keeps Enter for itself.
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest("button, a, summary, input, select, textarea, [role='button']");
    if (control && !control.matches("[data-nav-cursor]")) return;
    const action = id === "playSelected" ? "play" : id === "addSelectedToQueue" ? "queue" : "next";
    if (event.repeat) { event.preventDefault(); return; }
    const result = actOnCursor(main, action);
    if (!result) return;
    event.preventDefault();
    flashItem(result.item);
    if (result.text === null) announceShortcut(action === "queue" ? "Only songs can be queued" : "Only songs can play next");
    else if (result.text) announceShortcut(result.text);
  });
  useEffect(() => {
    window.addEventListener("keydown", handleListShortcut, true);
    const removePointerCursor = installPointerCursor();
    return () => {
      window.removeEventListener("keydown", handleListShortcut, true);
      removePointerCursor();
    };
  }, [handleListShortcut]);
  // Each screen or page rises in as it opens, in the frame it first paints.
  const shownView = useRef(viewKey);
  useLayoutEffect(() => {
    if (shownView.current === viewKey) return;
    shownView.current = viewKey;
    // The page is the last thing in the screen, after the search bar and sidebar.
    if (!isPlayerView) enterView(mainRef.current?.lastElementChild);
  }, [viewKey, isPlayerView]);

  // / filters the songs on the page; each page starts unfiltered.
  const [pageFilter, setPageFilter] = useState<{ view: string; query: string; focus: number } | null>(null);
  useEffect(() => setPageFilter(current => current && current.view !== viewKey ? null : current), [viewKey]);
  const activePageFilter = pageFilter?.view === viewKey && !isPlayerView ? pageFilter : null;
  const handlePageFilterShortcut = useStableCallback((event: KeyboardEvent) => {
    if (!matchesShortcut(event, "filterPage") || isPlayerView || ["search", "home", "settings"].includes(viewKey)) return;
    if (!acceptsPlaybackShortcut(event) || !mainRef.current?.querySelector(".columnInfo")) return;
    event.preventDefault();
    if (event.repeat) return;
    setPageFilter(current => ({
      view: viewKey,
      query: current?.view === viewKey ? current.query : "",
      focus: (current?.focus ?? 0) + 1,
    }));
  });
  useEffect(() => {
    window.addEventListener("keydown", handlePageFilterShortcut);
    return () => window.removeEventListener("keydown", handlePageFilterShortcut);
  }, [handlePageFilterShortcut]);

  return {
    mainRef,
    activeScrollElement,
    registerScrollElement,
    pageFilter: activePageFilter && {
      query: activePageFilter.query,
      focusRequest: activePageFilter.focus,
      onQueryChange: (query: string) => setPageFilter(current => current && { ...current, query }),
      onClose: () => setPageFilter(null),
    },
  };
}
