/**
 * Moving through the page's lists with the keyboard, the way a native list works: one item at a
 * time holds the keyboard cursor, takes focus, and stays in view; the selected-song shortcuts act
 * on it. Items are found in the page rather than registered, so every song row, search result,
 * card and "Show all" takes part without each list keeping its own cursor.
 */

import { useEffect, useRef } from "react";
import { isTypingTarget } from "./keyboard";
import { matchingShortcut, shortcutDefinition, shortcutIds } from "./shortcuts";

/** Everything a list cursor can rest on. */
const NAV_ITEMS = [
  ".libraryItem[data-track-id]",
  ".searchResult",
  ".searchEntity",
  ".searchShowAll",
  ".homeCardButton",
  ".libraryOverviewCard",
  ".libraryEntityButton",
  ".artistTextAction",
].join(", ");

// Pinned over the top of a scrolling list; a revealed item must clear them.
const STICKY_HEADERS = ".columnInfo, .playlistView .libraryHeader";

export type NavAction = "play" | "queue" | "next";
/** Handles an action on an item it owns; returns a description for the feedback notice, or null when the item isn't its. */
export type NavHandler = (action: NavAction, item: HTMLElement) => string | null | undefined;

const handlers = new Set<{ current: NavHandler }>();

/** Lets a list play, queue or play next whichever of its items holds the cursor. */
export function useNavActions(handler: NavHandler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    handlers.add(ref);
    return () => { handlers.delete(ref); };
  }, []);
}

let cursorKey: string | null = null;

function itemKey(item: HTMLElement, index: number) {
  return item.dataset.trackId ?? item.dataset.glide ?? `${item.className}:${item.textContent?.slice(0, 80)}:${index}`;
}

function isShown(item: HTMLElement) {
  if (item.closest("[hidden], [inert]")) return false;
  if (item.matches(":disabled, [data-unavailable]")) return false;
  return item.getClientRects().length > 0;
}

/** The page's items in reading order: down the page, and across a row of cards. */
function navItems(root: Element) {
  const items = Array.from(root.querySelectorAll<HTMLElement>(NAV_ITEMS)).filter(isShown);
  // Rows a few pixels apart, such as cards still gliding into place, count as one line.
  const positions = new Map(items.map(item => {
    const rect = item.getBoundingClientRect();
    return [item, { top: Math.round(rect.top / 8), left: rect.left }];
  }));
  // Search orders its sections with CSS, so the page's order is where things are, not the DOM's.
  return items.sort((a, b) => {
    const first = positions.get(a)!;
    const second = positions.get(b)!;
    return first.top - second.top || first.left - second.left;
  });
}

function scrollParent(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

/** Where the page stops being covered: below every header stuck at the top, gradient edge included. */
function visibleTop(scroller: HTMLElement, item: HTMLElement) {
  const bounds = scroller.getBoundingClientRect();
  let top = bounds.top;
  for (const header of scroller.querySelectorAll<HTMLElement>(STICKY_HEADERS)) {
    if (header.contains(item)) continue;
    const { position, top: offset } = getComputedStyle(header);
    if (position !== "sticky") continue;
    const rect = header.getBoundingClientRect();
    // Stuck rather than sitting in its place further down the page.
    if (rect.top <= bounds.top + (parseFloat(offset) || 0) + 1) top = Math.max(top, rect.bottom);
  }
  return top;
}

/** Scrolls an item fully into view, clear of the sticky headers above it and the player bar below. */
function reveal(item: HTMLElement) {
  item.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  const scroller = scrollParent(item);
  if (!scroller) return;
  const margin = 8;
  const clearTop = () => {
    const rect = item.getBoundingClientRect();
    const top = visibleTop(scroller, item);
    if (rect.top < top + margin) scroller.scrollBy({ top: rect.top - top - margin, behavior: "instant" });
    return rect.top < top + margin;
  };
  const bounds = scroller.getBoundingClientRect();
  const bar = document.querySelector<HTMLElement>("#bottomInfoBar");
  const bottom = Math.min(bounds.bottom, bar?.getBoundingClientRect().top ?? Infinity);
  const rect = item.getBoundingClientRect();
  if (rect.bottom > bottom - margin) scroller.scrollBy({ top: rect.bottom - bottom + margin, behavior: "instant" });
  // A playlist's header grows back as the page scrolls up, so check again once it has.
  else if (clearTop()) requestAnimationFrame(clearTop);
}

/**
 * Getting around by keyboard hides the pointer, and with it every hover effect; the keyboard's own
 * focus and cursor show instead (keyboardHover.ts). Moving the pointer brings it back.
 */
function showKeyboardCursor(shown: boolean) {
  document.documentElement.toggleAttribute("data-keyboard-nav", shown);
}

/** Hides the pointer until it next moves, as opening the full-screen player does. */
export function hidePointer() {
  showKeyboardCursor(true);
}

// Shortcuts that mean the keyboard is driving. Playback and opening settings are as often pressed
// with a hand still on the mouse, so they leave the pointer where it is.
const POINTER_HIDING_SHORTCUTS = shortcutIds.filter(id => shortcutDefinition(id).category !== "Playback" && id !== "openSettings");

function placeCursor(item: HTMLElement, items: HTMLElement[]) {
  clearCursorMark();
  cursorKey = itemKey(item, items.indexOf(item));
  item.setAttribute("data-nav-cursor", "");
  // Rows aren't in the tab order; focusing one lets Enter and the arrows start from it.
  if (!item.matches("button, a, [tabindex]")) item.tabIndex = -1;
  item.focus({ preventScroll: true });
  reveal(item);
  showKeyboardCursor(true);
}

/** The item holding the cursor on this page, if it's still there. */
export function cursorItem(root: Element | null | undefined) {
  if (!root || cursorKey === null) return null;
  const items = navItems(root);
  return items.find((item, index) => itemKey(item, index) === cursorKey) ?? null;
}

function firstVisible(items: HTMLElement[]) {
  return items.find(item => {
    const rect = item.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  }) ?? items[0];
}

/** Moves the cursor; false when the page has no list, so the key can do what it would anyway. */
export function moveCursor(root: Element | null | undefined, move: 1 | -1 | "first" | "last"): boolean {
  if (!root) return false;
  const items = navItems(root);
  if (!items.length) return false;
  if (move === "first" || move === "last") {
    // A long list only has the rows near the view; go to its end first, then onto the item there.
    const edge = move === "first" ? items[0] : items[items.length - 1];
    const scroller = scrollParent(edge);
    if (scroller) {
      scroller.scrollTo({ top: move === "first" ? 0 : scroller.scrollHeight, behavior: "instant" });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const settled = navItems(root);
        const target = move === "first" ? settled[0] : settled[settled.length - 1];
        if (target) placeCursor(target, settled);
      }));
    }
    placeCursor(edge, items);
    return true;
  }
  const current = cursorItem(root);
  const index = current ? items.indexOf(current) : -1;
  const target = index < 0 ? firstVisible(items) : items[Math.max(0, Math.min(items.length - 1, index + move))];
  placeCursor(target, items);
  return true;
}

/** Plays, queues or plays next the item holding the cursor; null when nothing holds it. */
export function actOnCursor(root: Element | null | undefined, action: NavAction): { item: HTMLElement; text: string | null } | null {
  const item = cursorItem(root);
  if (!item) return null;
  for (const handler of handlers) {
    const text = handler.current(action, item);
    if (text !== null && text !== undefined) return { item, text };
  }
  if (action !== "play") return { item, text: item.matches(".queueItem") ? "Already in the queue" : null };
  // Cards, albums and "Show all" do what clicking them does; a queue row plays from its button.
  const button = item.querySelector<HTMLButtonElement>(".trackPlayButton:not(:disabled)");
  (button ?? item).click();
  return { item, text: "" };
}

/** Briefly lights up the item an action was taken on. */
export function flashItem(item: HTMLElement) {
  item.removeAttribute("data-nav-flash");
  void item.offsetWidth;
  item.setAttribute("data-nav-flash", "");
  item.addEventListener("animationend", () => item.removeAttribute("data-nav-flash"), { once: true });
}

function clearCursorMark() {
  for (const previous of document.querySelectorAll("[data-nav-cursor]")) previous.removeAttribute("data-nav-cursor");
}

/** The pointer takes over: clicking an item moves the cursor there, without showing it. */
export function installPointerCursor() {
  const onPointerDown = (event: PointerEvent) => {
    showKeyboardCursor(false);
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>(NAV_ITEMS) : null;
    if (!item) return;
    clearCursorMark();
    const root = item.closest("main") ?? document.body;
    cursorKey = itemKey(item, navItems(root).indexOf(item));
    item.setAttribute("data-nav-cursor", "");
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.movementX || event.movementY) showKeyboardCursor(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Letters typed into a field aren't shortcuts, even when they share a key with one.
    if (isTypingTarget(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey) return;
    if (matchingShortcut(event, POINTER_HIDING_SHORTCUTS)) showKeyboardCursor(true);
  };
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("keydown", onKeyDown, true);
  return () => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("keydown", onKeyDown, true);
  };
}

// The sidebar's own stops: its pages, playlists, dropdowns and buttons, and the filter when shown.
const SIDEBAR_ITEMS = ".sidebarFilterInput, .sidebarBtn, .sidebarPlaylistGroup > summary, #createPlaylistBtn, .settingsBack";
export const SIDEBAR_ROOT = "#sidebarMain, .settingsSidebar";

export function sidebarRoot(container: Element | null | undefined) {
  return container?.querySelector<HTMLElement>(SIDEBAR_ROOT) ?? null;
}

/** Moves focus to the next or previous thing in the sidebar, starting from the current page. */
export function moveSidebar(container: Element | null | undefined, step: 1 | -1) {
  const sidebar = sidebarRoot(container);
  if (!sidebar) return false;
  const items = Array.from(sidebar.querySelectorAll<HTMLElement>(SIDEBAR_ITEMS)).filter(isShown);
  if (!items.length) return false;
  const focused = items.indexOf(document.activeElement as HTMLElement);
  const current = focused >= 0 ? focused : items.findIndex(item => item.getAttribute("aria-current") === "page");
  const target = items[current < 0 ? (step > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, current + step))];
  // One place looks hovered at a time; the list keeps its position for when the keyboard returns.
  clearCursorMark();
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest", behavior: "instant" });
  showKeyboardCursor(true);
  return true;
}
