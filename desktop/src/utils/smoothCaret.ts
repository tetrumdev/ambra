/**
 * A text caret that glides to its new place instead of jumping, drawn over single-line
 * text fields. It sits next to the focused field, so it scrolls, clips and stacks with it.
 * The native caret is hidden only while this one is drawn: number fields, read-only fields
 * and centred or right-to-left text keep the platform's own.
 */
const TEXT_TYPES = new Set(["text", "search", "url", "email", "tel"]);
const TYPOGRAPHY = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariant",
  "fontFeatureSettings", "fontVariationSettings", "fontKerning", "letterSpacing", "wordSpacing", "textTransform",
] as const;
const CARET_WIDTH = 2;
/** Visible half, then hidden half, as the platform caret blinks. */
const BLINK = [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }];
const BLINK_PERIOD = 1060;

export function installSmoothCaret() {
  const box = document.createElement("span");
  box.className = "smoothCaret";
  box.setAttribute("aria-hidden", "true");
  const bar = document.createElement("span");
  bar.className = "smoothCaretBar";
  box.append(bar);
  // Measures the text before the caret in the field's own typography.
  const mirror = document.createElement("span");
  mirror.className = "smoothCaretMirror";
  mirror.setAttribute("aria-hidden", "true");
  document.body.append(mirror);

  let field: HTMLInputElement | null = null;
  let frame = 0;
  let lastX = Number.NaN;
  let blink: Animation | undefined;
  // shortcut: a field moved by its siblings without resizing is only caught on the next event; track per frame if that shows up.
  const resize = new ResizeObserver(() => schedule());

  const release = () => {
    if (!field) return;
    field.removeAttribute("data-smooth-caret");
    resize.disconnect();
    box.remove();
    blink?.cancel();
    field = null;
    lastX = Number.NaN;
  };

  const attach = (element: Element | null) => {
    if (!(element instanceof HTMLInputElement) || !TEXT_TYPES.has(element.type) || element.readOnly || element.disabled) return false;
    const style = getComputedStyle(element);
    if (style.direction !== "ltr" || (style.textAlign !== "start" && style.textAlign !== "left")) return false;
    field = element;
    field.setAttribute("data-smooth-caret", "");
    field.after(box);
    resize.observe(field);
    return true;
  };

  const update = () => {
    frame = 0;
    const active = document.activeElement;
    if (field && (active !== field || !field.isConnected)) release();
    const arrived = !field;
    if (arrived && !attach(active)) return;
    const input = field!;

    const { selectionStart, selectionEnd } = input;
    box.hidden = selectionStart === null || selectionStart !== selectionEnd;
    if (box.hidden) return;

    const style = getComputedStyle(input);
    for (const property of TYPOGRAPHY) mirror.style[property] = style[property];
    // The zero-width space gives an empty prefix a line box to measure the height from.
    mirror.textContent = `${input.value.slice(0, selectionStart!)}​`;
    const text = mirror.getBoundingClientRect();

    const padLeft = parseFloat(style.paddingLeft);
    const padTop = parseFloat(style.paddingTop);
    const width = input.clientWidth - padLeft - parseFloat(style.paddingRight);
    const height = input.clientHeight - padTop - parseFloat(style.paddingBottom);
    const fieldRect = input.getBoundingClientRect();
    box.style.left = "0px";
    box.style.top = "0px";
    const origin = box.getBoundingClientRect();
    box.style.left = `${fieldRect.left + input.clientLeft + padLeft - origin.left}px`;
    box.style.top = `${fieldRect.top + input.clientTop + padTop - origin.top}px`;
    box.style.width = `${Math.max(0, width)}px`;
    box.style.height = `${Math.max(0, height)}px`;

    // WebKit centres its caret on the character boundary and keeps it inside the content box.
    const x = Math.max(0, Math.min(text.width - input.scrollLeft - CARET_WIDTH / 2, width - CARET_WIDTH));
    bar.style.background = style.color;
    bar.style.height = `${text.height}px`;
    bar.style.top = `${(height - text.height) / 2}px`;
    // A caret arriving in a field appears in place; only moves within it glide.
    if (arrived) bar.style.transition = "none";
    bar.style.transform = `translateX(${x}px)`;
    if (arrived) {
      void bar.offsetWidth;
      bar.style.transition = "";
    }
    if (x !== lastX) {
      lastX = x;
      blink?.cancel();
      blink = bar.animate(BLINK, { duration: BLINK_PERIOD, iterations: Infinity });
    }
  };

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  for (const type of ["focusin", "focusout", "selectionchange", "input", "keyup", "pointerup", "scroll"]) {
    document.addEventListener(type, schedule, true);
  }
  window.addEventListener("resize", schedule);
}
