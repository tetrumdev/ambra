function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

/**
 * Scrolls a list of equal-height rows so the item at `index` sits mid-view, even when a
 * virtualized list hasn't rendered it yet. `firstIndex` is the index of the first rendered row.
 */
export function revealListItem(list: HTMLElement, index: number, firstIndex: number) {
  const rows = list.querySelectorAll<HTMLElement>(":scope > [data-virtual-item]");
  const first = rows[0];
  const scroller = scrollParent(list);
  if (!first || !scroller) return;
  const firstTop = first.getBoundingClientRect().top;
  const step = rows[1] ? rows[1].getBoundingClientRect().top - firstTop : first.offsetHeight;
  const top = firstTop + (index - firstIndex) * step;
  const view = scroller.getBoundingClientRect();
  scroller.scrollTop += top - view.top - (scroller.clientHeight - step) / 2;
}
