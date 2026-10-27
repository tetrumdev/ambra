import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { TrackPlaybackMenu } from "../src/components/TrackPlaybackMenu";
import { isKeyboardMenuClick } from "../src/utils/trackMenu";

const dom = new Window({ url: "http://localhost/" });
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement;
let trigger: HTMLButtonElement;
beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
    getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  });
  globalThis.fetch = (() => Promise.resolve(Response.json({ tidal: false, qobuz: false, spotify: false }))) as typeof fetch;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  host?.remove(); trigger?.remove();
});
afterAll(() => { globalThis.fetch = originalFetch; dom.happyDOM.abort(); });

async function mount(keyboard = false, onClose = () => {}) {
  trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<TrackPlaybackMenu
    xPos={100} yPos={100} trackId="local:menu-test" openedWithKeyboard={keyboard}
    onClose={onClose} playStandalone={() => {}} playTrack={() => {}} playNext={() => {}} addToQueue={() => {}}
  />));
}
const menu = () => host.querySelector<HTMLDivElement>('[role="menu"]')!;
const item = (id: string) => host.querySelector<HTMLButtonElement>(`#${id}`)!;
async function key(value: string) {
  await act(async () => {
    document.activeElement!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: value, bubbles: true }));
  });
}

test("pointer clicks and pointer context menus do not become keyboard opens", () => {
  expect(isKeyboardMenuClick({ type: "click", detail: 1 })).toBe(false);
  expect(isKeyboardMenuClick({ type: "contextmenu", detail: 0 })).toBe(false);
  expect(isKeyboardMenuClick({ type: "click", detail: 0 })).toBe(true);
});

test("a pointer open focuses the menu without selecting Standalone Play", async () => {
  await mount();
  expect(document.activeElement).toBe(menu());
  expect(menu().dataset.navigation).toBe("pointer");
  expect(document.activeElement).not.toBe(item("standalonePlay"));
  await key("ArrowDown");
  expect(document.activeElement).toBe(item("standalonePlay"));
  expect(menu().dataset.navigation).toBe("keyboard");
});

test("ArrowUp from an unselected pointer menu starts at the last action", async () => {
  await mount();
  await key("ArrowUp");
  expect(document.activeElement).toBe(item("addToQueue"));
  await key("ArrowDown");
  expect(document.activeElement).toBe(item("standalonePlay"));
});

test("keyboard opens retain navigation and restore focus on close", async () => {
  let closed = false;
  await mount(true, () => { closed = true; });
  expect(document.activeElement).toBe(item("standalonePlay"));
  expect(menu().dataset.navigation).toBe("keyboard");
  await key("End"); expect(document.activeElement).toBe(item("addToQueue"));
  await key("Home"); expect(document.activeElement).toBe(item("standalonePlay"));
  await key("Escape"); expect(closed).toBe(true);
  await act(async () => root!.unmount()); root = undefined;
  expect(document.activeElement).toBe(trigger);
});

test("pointer movement takes over keyboard focus and arrow keys can take it back", async () => {
  await mount(true);
  await act(async () => { item("playNext").dispatchEvent(new dom.PointerEvent("pointermove", { bubbles: true })); });
  expect(document.activeElement).toBe(item("playNext"));
  expect(menu().dataset.navigation).toBe("pointer");
  await key("ArrowDown");
  expect(document.activeElement).toBe(item("addToQueue"));
  expect(menu().dataset.navigation).toBe("keyboard");
});

// Optional real-browser regression: point AMBRA_TEST_PLAYWRIGHT at an installed
// playwright-core/index.mjs, with Node on PATH (or AMBRA_TEST_NODE). This bundles
// the actual component and uses native pointer/keyboard events to check styles.
test.skipIf(!process.env.AMBRA_TEST_PLAYWRIGHT)("Chromium never leaves a second action highlighted after pointer/keyboard handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ambra-menu-focus-"));
  try {
    const desktop = resolve(import.meta.dir, "..");
    const modulePath = (path: string) => JSON.stringify(join(desktop, path).replaceAll("\\", "/"));
    const entry = join(directory, "menu.ts");
    await writeFile(entry, `
import { createElement } from ${modulePath("node_modules/react/index.js")};
import { createRoot } from ${modulePath("node_modules/react-dom/client.js")};
import { flushSync } from ${modulePath("node_modules/react-dom/index.js")};
import { TrackPlaybackMenu } from ${modulePath("src/components/TrackPlaybackMenu.tsx")};
import { isKeyboardMenuClick } from ${modulePath("src/utils/trackMenu.ts")};
window.fetch = async () => Response.json({tidal:false,qobuz:false,spotify:false});
const root = createRoot(document.getElementById('root'));
const close = () => flushSync(() => root.render(null));
for (const id of ['pointerTrigger', 'keyboardTrigger']) {
  document.getElementById(id).addEventListener('click', event => {
    flushSync(() => root.render(createElement(TrackPlaybackMenu, {
      xPos:180,yPos:120,trackId:'local:test',openedWithKeyboard:isKeyboardMenuClick(event),
      onClose:close,playStandalone:close,playTrack:close,playNext:close,addToQueue:close,
    })));
  });
}
`);
    const built = await Bun.build({
      entrypoints: [entry], target: "browser", minify: true,
      define: { "import.meta.env": "{}", "process.env.NODE_ENV": JSON.stringify("production") },
      plugins: [{ name: "css-in-document", setup(build) {
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      } }],
    });
    expect(built.success, String(built.logs)).toBe(true);
    const css = await readFile(join(desktop, "src/components/TrackMenus.css"), "utf8");
    const script = (await built.outputs[0].text()).replaceAll("</script", "<\\/script");
    const htmlPath = join(directory, "menu.html");
    await writeFile(htmlPath, `<style>${css}</style><input id="field"><div id="pointerTrigger">Pointer row</div><button id="keyboardTrigger">Keyboard options</button><div id="root"></div><script>${script}</script>`);
    // Playwright's Windows browser pipes require Node; Bun runs the component
    // tests and bundle, while this short runner supplies native browser events.
    const runner = join(directory, "browser.mjs");
    await writeFile(runner, `
import assert from 'node:assert/strict';
import { chromium } from ${JSON.stringify(pathToFileURL(process.env.AMBRA_TEST_PLAYWRIGHT!).href)};
const browser = await chromium.launch({ headless: true, timeout: 10_000 });
try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(${JSON.stringify(pathToFileURL(htmlPath).href)});
    assert.deepEqual(errors, []);
    const base = "rgba(29, 29, 29, 0.7)";
    const highlighted = "rgba(42, 42, 42, 0.7)";
    const color = id => page.locator('#root #' + id).evaluate(element => getComputedStyle(element).backgroundColor);
    // A field keeps :focus-visible even after pointer use. Opening from a
    // non-focusable playlist row must not transfer that heuristic to an action.
    await page.locator("#field").fill("previous focus");
    await page.locator("#pointerTrigger").click();
    await page.waitForSelector('#root #trackPlaybackMenu[data-navigation="pointer"]');
    assert.equal(await color("standalonePlay"), base);
    await page.locator("#root #playNext").hover();
    assert.equal(await color("standalonePlay"), base);
    assert.equal(await color("playNext"), highlighted);
    await page.locator("#root #addToQueue").hover();
    assert.equal(await color("playNext"), base);
    assert.equal(await color("addToQueue"), highlighted);
    // The cursor remains over Add to Queue while keyboard focus moves away.
    await page.keyboard.press("ArrowUp");
    assert.equal(await color("playNext"), highlighted);
    assert.equal(await color("addToQueue"), base);
    await page.keyboard.press("Escape");
    await page.locator("#keyboardTrigger").focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector('#root #trackPlaybackMenu[data-navigation="keyboard"]');
    assert.equal(await color("standalonePlay"), highlighted);
    await page.locator("#root #playNext").hover();
    assert.equal(await color("standalonePlay"), base);
    assert.equal(await color("playNext"), highlighted);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#keyboardTrigger").evaluate(element => element === document.activeElement), true);
    assert.deepEqual(errors, []);
    console.log('Pointer and keyboard menu styles passed');
} finally { await browser.close(); }
`);
    const child = Bun.spawn([process.env.AMBRA_TEST_NODE ?? "node", runner], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    const diagnostics = await new Response(child.stderr).text();
    expect(await child.exited, diagnostics).toBe(0);
    expect(output).toContain("Pointer and keyboard menu styles passed");
  } finally {
    expect(dirname(directory)).toBe(tmpdir());
    expect(basename(directory).startsWith("ambra-menu-focus-")).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
