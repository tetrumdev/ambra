/** Every track menu's width, wide enough that no action wraps. Keep TrackMenus.css in step. */
export const MENU_WIDTH = 220;

/** Keyboard button activation has no click count; a pointer contextmenu can also have detail 0. */
export function isKeyboardMenuClick(event: { type: string; detail: number }) {
  return event.type === "click" && event.detail === 0;
}
