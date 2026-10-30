/**
 * Hover belongs to the pointer. While the keyboard is in use the pointer is hidden
 * (`data-keyboard-nav` on the root, src/utils/keyboardNav.ts), so every `:hover` rule in the
 * app's CSS stops applying and a copy takes its place for whatever the keyboard is on: the
 * focused control, the list item holding the keyboard cursor, and anything containing either,
 * just as hover applies to an element and its ancestors. Done at build time so each stylesheet
 * keeps writing plain `:hover` and the keyboard look can't drift from it.
 */

type Rule = {
  selectors: string[];
  source?: { input?: { file?: string } };
  cloneAfter: (overrides: { selectors: string[] }) => unknown;
};
type Root = { walkRules: (callback: (rule: Rule) => void) => void };

const POINTER = ":not([data-keyboard-nav])";
const KEYBOARD = "[data-keyboard-nav]";
const KEYBOARD_HOVER = ":is(:focus-visible, [data-nav-cursor], :has(:focus-visible, [data-nav-cursor]))";
// `:has()` can't hold another `:has()`.
const KEYBOARD_HOVER_IN_HAS = ":is(:focus-visible, [data-nav-cursor])";

/** Limits a selector to one input mode without changing its specificity. */
function onlyWhen(selector: string, state: string) {
  const root = selector.match(/^\s*(:root|html)(?![\w-])/);
  if (root) return selector.replace(root[0], `${root[0]}:where(${state})`);
  return `:where(:root${state}) ${selector}`;
}

/** The selector with each `:hover` matching what the keyboard is on instead. */
function keyboardSelector(selector: string) {
  let result = "";
  const functions: string[] = [];
  for (let index = 0; index < selector.length; index++) {
    if (selector.startsWith(":hover", index) && !/[\w-]/.test(selector[index + 6] ?? "")) {
      result += functions.includes("has") ? KEYBOARD_HOVER_IN_HAS : KEYBOARD_HOVER;
      index += 5;
      continue;
    }
    const char = selector[index];
    if (char === "(") functions.push(result.match(/:([\w-]+)$/)?.[1] ?? "");
    else if (char === ")") functions.pop();
    result += char;
  }
  return result;
}

export function keyboardHover() {
  return {
    postcssPlugin: "ambra-keyboard-hover",
    OnceExit(root: Root) {
      root.walkRules(rule => {
        if (rule.source?.input?.file?.includes("node_modules")) return;
        const hovers = rule.selectors.filter(selector => selector.includes(":hover"));
        if (!hovers.length) return;
        // In a rule of its own: a selector the engine rejects would drop the whole rule.
        rule.cloneAfter({ selectors: hovers.map(selector => onlyWhen(keyboardSelector(selector), KEYBOARD)) });
        rule.selectors = rule.selectors.map(selector => selector.includes(":hover") ? onlyWhen(selector, POINTER) : selector);
      });
    },
  };
}
