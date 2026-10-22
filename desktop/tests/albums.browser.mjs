import assert from "node:assert/strict";

const { chromium } = await import(process.env.AMBRA_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`${process.env.AMBRA_ALBUMS_PREVIEW_URL ?? "http://127.0.0.1:1420"}/tests/albums.html`);
  await page.locator(".libraryItem").waitFor();
  assert.equal(await page.getByRole("button", { name: "Saved songs", exact: true }).count(), 0);
  assert.match(await page.locator(".collectionQuality").innerText(), /24-bit · 96 kHz/);
  assert.equal(await page.locator(".albumAbout .creditList").count(), 0);
  await page.getByRole("button", { name: "Credits", exact: true }).click();
  const credits = page.getByRole("dialog", { name: "Credits for A Night at the Opera", exact: true });
  await credits.getByText("Roy Thomas Baker").waitFor();
  assert.match(await credits.innerText(), /Track 1/);
  await page.keyboard.press("Escape");
  await credits.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Versions", exact: true }).click();
  const versions = page.getByRole("dialog", { name: "Versions of A Night at the Opera", exact: true });
  await versions.getByText("Tidal", { exact: false }).waitFor();
  assert.equal(await versions.locator(".albumVersion").count(), 2);
  assert.match(await versions.locator('[aria-current="true"]').innerText(), /Qobuz/);
  if (process.env.AMBRA_ALBUMS_SCREENSHOT) await page.screenshot({ path: process.env.AMBRA_ALBUMS_SCREENSHOT });
  await versions.getByRole("button", { name: /Deluxe Edition/ }).click();
  await page.getByRole("heading", { name: "A Night at the Opera (Deluxe Edition)", exact: true }).waitFor();
  // The second copy lacks album-level artist metadata; track credits must supply the link.
  await page.locator(".entityByline").getByRole("button", { name: "Queen", exact: true }).click();
  await page.locator(".artistView").waitFor();
  assert.equal(await page.getByRole("heading", { name: "Queen", exact: true }).count(), 1);
  const opened = await page.evaluate(() => window.albumHarness.opened);
  assert.equal(opened[0].album.provider, "tidal");
  assert.equal(opened[0].album.versions.length, 2);
  assert.equal(opened[1].artist.id, "tidal:queen");
  assert.deepEqual(errors, []);
  console.log("Browser checks passed: album quality, empty saved scope, credits dialog and Escape, retained versions, provider switching, artist navigation from track credits.");
} catch (error) {
  console.error({ errors, text: await page.locator("body").innerText() });
  throw error;
} finally {
  await browser.close();
}
