import assert from "node:assert/strict";

const { chromium } = await import(process.env.AMBRA_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const heading = async title => page.getByRole("heading", { name: title, exact: true }).waitFor();
const sidebar = name => page.locator("#sidebarMain").getByRole("button", { name, exact: true });
const mouseHistory = async button => {
  for (const type of ["mousedown", "mouseup", "auxclick"]) await page.dispatchEvent("body", type, { button, bubbles: true, cancelable: true });
};
try {
  await page.goto(`${process.env.AMBRA_NAVIGATION_PREVIEW_URL ?? "http://127.0.0.1:1420"}/tests/navigation.html`);
  await heading("Welcome Back");
  await sidebar("My Library").click(); await heading("My Library");
  await sidebar("Tracks").click(); await heading("Tracks");
  await page.keyboard.press("Escape"); await heading("Tracks");
  await page.keyboard.press("Alt+ArrowLeft"); await heading("My Library");
  await page.keyboard.press("Alt+ArrowRight"); await heading("Tracks");
  await mouseHistory(3); await heading("My Library");
  await mouseHistory(4); await heading("Tracks");
  // Settings opens on General, and Escape leaves it like any place you visit.
  await page.keyboard.press("Control+Comma");
  await page.locator('#settings-tab-general[aria-current="page"]').waitFor();
  await page.keyboard.press("Escape"); await heading("Tracks");
  await page.keyboard.press("Control+Comma");
  await page.locator('#settings-tab-general[aria-current="page"]').waitFor();
  await page.getByRole("button", { name: "Outputs", exact: true }).click();
  await page.locator('#settings-tab-outputs[aria-current="page"]').waitFor();
  await page.keyboard.press("Alt+ArrowLeft");
  await page.locator('#settings-tab-general[aria-current="page"]').waitFor();
  await page.keyboard.press("Alt+ArrowLeft"); await heading("Tracks");
  await page.keyboard.press("Alt+ArrowRight");
  await page.locator('#settings-tab-general[aria-current="page"]').waitFor();
  await page.keyboard.press("Alt+ArrowLeft"); await heading("Tracks");
  await sidebar("Albums").click(); await heading("Albums");
  await page.keyboard.press("Alt+ArrowRight"); await heading("Albums");
  await sidebar("Navigation Mix").click(); await heading("Navigation Mix");
  await page.locator(".albumName").getByRole("button", { name: "A Night at the Opera", exact: true }).click();
  await heading("A Night at the Opera");
  await page.keyboard.press("Escape"); await heading("A Night at the Opera");
  await page.locator(".entityByline").getByRole("button", { name: "Queen", exact: true }).click();
  await heading("Queen");
  await page.keyboard.press("Escape"); await heading("Queen");
  await page.keyboard.press("Alt+ArrowLeft"); await heading("A Night at the Opera");
  await page.keyboard.press("Alt+ArrowRight"); await heading("Queen");
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "BrowserBack", bubbles: true, cancelable: true })));
  await heading("A Night at the Opera");
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "BrowserForward", bubbles: true, cancelable: true })));
  await heading("Queen");
  await page.keyboard.press("Meta+BracketLeft"); await heading("A Night at the Opera");
  await page.keyboard.press("Meta+BracketRight"); await heading("Queen");
  await page.keyboard.press("Control+KeyF");
  await page.getByRole("searchbox", { name: "Search songs" }).fill("Queen");
  await page.locator("main#search").waitFor();
  await page.keyboard.press("Escape"); await page.locator("main#search").waitFor();
  await sidebar("My Library").click(); await heading("My Library");
  await page.keyboard.press("Alt+ArrowLeft"); await page.locator("main#search").waitFor();
  assert.equal(await page.getByRole("searchbox", { name: "Search songs" }).inputValue(), "Queen");
  await page.keyboard.press("KeyQ"); await page.locator("main#queue").waitFor();
  await page.getByRole("button", { name: "Actions for Bohemian Rhapsody", exact: true }).click();
  await page.getByRole("button", { name: "Credits", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Credits for Bohemian Rhapsody", exact: true });
  await dialog.waitFor();
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
  await page.locator("main#queue").waitFor();
  await page.keyboard.press("Escape"); await page.locator("main#search").waitFor();
  await page.getByRole("button", { name: "Open bigscreen player" }).click();
  await page.getByRole("button", { name: "Close player" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close player" }).waitFor({ state: "hidden" });
  await page.locator("main#search").waitFor();
  // Dismissible views never add history entries.
  await page.keyboard.press("Alt+ArrowLeft"); await heading("Queen");
  assert.deepEqual(errors, []);
  console.log("Browser checks passed: page Escape behavior; keyboard and mouse back/forward; settings tabs; history branching; albums and artists; search restoration; popup, queue and player dismissal.");
} catch (error) {
  console.error({ errors, text: await page.locator("body").innerText() });
  throw error;
} finally {
  await browser.close();
}
