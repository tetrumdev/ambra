import assert from "node:assert/strict";

// Browser verification is optional tooling, not a dependency of the application.
const { chromium } = await import(process.env.AMBRA_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.AMBRA_BROWSER_EXECUTABLE ? { executablePath: process.env.AMBRA_BROWSER_EXECUTABLE } : {}),
});
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`${process.env.AMBRA_LYRICS_PREVIEW_URL ?? "http://127.0.0.1:1420"}/tests/lyrics.html`);
  await page.locator('[data-row="0"]').waitFor();
  const state = () => page.locator('[data-row="0"] .lyricSegment').evaluateAll(nodes => nodes.map(node => ({
    text: node.textContent, fill: node.style.getPropertyValue("--lyric-progress"),
  })));
  const load = async sync => {
    const title = await page.evaluate(sync => window.lyricsHarness.load(sync), sync);
    // Correlate the new request and DOM; a previous fixture must never satisfy this wait.
    await page.waitForFunction(({ title, sync }) => {
      const request = window.lyricsHarness.requests.find(request => request.title === title);
      const row = document.querySelector('[data-row="0"]');
      return document.querySelector("h1")?.textContent === title && request && !request.aborted
        && (sync === "none" ? document.querySelector(".lyricsPlain")
          : row?.getAttribute("data-detail") === String(sync !== "line"));
    }, { title, sync });
  };
  await page.evaluate(() => window.lyricsHarness.time(1.5));
  let current = await state();
  assert.equal(current[0].fill, "50.00%");
  assert.equal(current[1].fill, "0.00%");
  assert.equal(await page.locator('[data-row="0"]').getAttribute("data-active"), "true");
  await page.evaluate(() => window.lyricsHarness.time(2.5));
  current = await state();
  assert.equal(current[0].fill, "100.00%");
  assert.equal(current[1].fill, "50.00%");
  await page.evaluate(() => window.lyricsHarness.time(1.2));
  current = await state();
  assert.equal(current[0].fill, "20.00%");
  assert.equal(current[1].fill, "0.00%");
  await page.evaluate(() => window.lyricsHarness.time(3.2));
  assert.equal(await page.locator('[data-row="0-bg-0"]').getAttribute("data-active"), "true");
  assert.equal(await page.locator('[data-row="0"]').getAttribute("data-active"), "false");
  await page.evaluate(() => { window.lyricsHarness.time(1.2); window.lyricsHarness.playing(true); });
  await page.waitForTimeout(80);
  assert(Number.parseFloat((await state())[0].fill) > 20);
  await page.evaluate(() => window.lyricsHarness.playing(false));
  const paused = await state();
  await page.waitForTimeout(120);
  assert.deepEqual(await state(), paused);
  await load("syllable");
  await page.evaluate(() => window.lyricsHarness.time(1.25));
  current = await state();
  assert.equal(current[0].text, "Am");
  assert.equal(current[0].fill, "50.00%");
  await load("line");
  await page.evaluate(() => window.lyricsHarness.time(1.5));
  assert.equal(await page.locator('[data-row="0"]').getAttribute("data-active"), "true");
  assert.equal((await state())[0].fill, "");
  await load("none");
  const plain = await page.locator(".lyricsPlain").innerText();
  assert(plain.includes("Timing unavailable") && plain.includes("Lumière ambrée"));
  const slowTitle = await page.evaluate(() => window.lyricsHarness.load("word", 2000));
  await page.waitForFunction(title => window.lyricsHarness.requests.some(request => request.title === title), slowTitle);
  await load("line");
  await page.waitForFunction(title => window.lyricsHarness.requests.some(request => request.title === title && request.aborted), slowTitle);
  assert.equal(await page.locator('[data-row="0"]').getAttribute("data-detail"), "false", JSON.stringify(await page.evaluate(() => ({ text: document.body.innerText, requests: window.lyricsHarness.requests }))));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.lyricsHarness.time(4.5));
  assert.equal(await page.locator('[data-row="1"]').evaluate(node => getComputedStyle(node).transform), "none");
  assert.deepEqual(errors, []);
  console.log("Browser checks passed: progressive fill, seeks, background vocals, pause/resume, syllables, line-only, plain annotations, cancellation, reduced motion.");
} finally {
  await browser.close();
}
