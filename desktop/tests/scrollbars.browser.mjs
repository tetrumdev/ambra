import assert from "node:assert/strict";

const { chromium } = await import(process.env.AMBRA_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const view = page.locator(".homeView");
const rail = page.locator(".appScrollbar");
const thumb = page.locator(".appScrollbarThumb");
const position = () => view.evaluate(element => element.scrollTop);
const settleAt = async expected => {
  await page.waitForFunction(value => Math.abs(document.querySelector(".homeView").scrollTop - value) < 1, expected);
};
const reset = async () => {
  await view.evaluate(element => { element.scrollTop = 0; });
  await settleAt(0);
};

try {
  await page.goto(`${process.env.AMBRA_FEATURES_PREVIEW_URL ?? "http://127.0.0.1:1420"}/tests/features.html`);
  await page.getByRole("heading", { name: "Welcome Back" }).waitFor();
  // Production imports this from main.tsx; the lightweight feature fixture mounts App directly.
  await page.evaluate(() => import("/src/scrollbars.css"));
  await thumb.waitFor({ state: "visible" });

  // An overflowing home shelf has no native bar, but its existing arrows still scroll it.
  await page.locator(".homeRow").first().evaluate(row => {
    const card = row.firstElementChild;
    for (let index = 0; index < 11; index++) row.append(card.cloneNode(true));
    row.dispatchEvent(new Event("scroll"));
  });
  const shelf = page.locator(".homeRow").first();
  assert.equal(await shelf.evaluate(element => getComputedStyle(element).scrollbarWidth), "none");
  assert.equal(await shelf.evaluate(element => getComputedStyle(element, "::-webkit-scrollbar").display), "none");
  await page.getByRole("button", { name: "Scroll right: Recently played", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".homeRow").scrollLeft > 100);
  await reset();

  // The visible thumb keeps its shape and width, including on hover.
  await thumb.hover();
  assert.equal(await thumb.evaluate(element => getComputedStyle(element, "::before").width), "4px");
  await reset();

  // Coarse mouse wheels ease over multiple frames and accumulate rapid input.
  const wheel = deltaY => view.dispatchEvent("wheel", { deltaY, deltaMode: 0, bubbles: true, cancelable: true });
  const early = await view.evaluate(element => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
    return element.scrollTop;
  });
  assert.equal(early, 0, "wheel movement starts on the animation frame");
  await wheel(120);
  await settleAt(240);
  assert.equal(await rail.getAttribute("data-active"), "true");
  await wheel(-120);
  await settleAt(120);

  // Dragging moves the content immediately, including outside the narrow rail.
  await reset();
  let bounds = await thumb.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  assert.equal(await thumb.getAttribute("data-dragging"), "true");
  assert.equal(await thumb.evaluate(element => getComputedStyle(element, "::before").transform), "none");
  await page.mouse.move(bounds.x - 100, bounds.y + bounds.height / 2 + 90);
  assert.ok(await position() > 30);
  await page.mouse.up();
  assert.equal(await thumb.getAttribute("data-dragging"), null);
  const metrics = await view.evaluate(element => ({ top: element.scrollTop, maximum: element.scrollHeight - element.clientHeight }));
  const railBounds = await rail.boundingBox();
  bounds = await thumb.boundingBox();
  assert.ok(Math.abs(bounds.y - railBounds.y - (metrics.top / metrics.maximum) * (railBounds.height - bounds.height)) < 2);

  // Clicking the track seeks smoothly, and the rail accepts the wheel itself.
  await reset();
  await page.mouse.click(railBounds.x + railBounds.width / 2, railBounds.y + railBounds.height - 5);
  await settleAt(metrics.maximum);
  await rail.dispatchEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
  await settleAt(metrics.maximum - 120);

  // Reduced motion is immediate; fine trackpad input remains available to the browser.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await reset();
  await wheel(120);
  assert.equal(await position(), 120);
  assert.equal(await thumb.evaluate(element => getComputedStyle(element, "::before").transitionDuration), "0s");
  assert.equal(await thumb.evaluate(element => getComputedStyle(element, "::before").transform), "none");
  const fineInput = await view.evaluate(element => {
    const event = new WheelEvent("wheel", { deltaY: 5, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(fineInput, false);

  // Content resizing updates the thumb without a scroll event; no overflow collapses the rail.
  const oldHeight = (await thumb.boundingBox()).height;
  await view.evaluate(element => {
    const spacer = document.createElement("div");
    spacer.id = "scrollbar-test-spacer";
    spacer.style.height = "1500px";
    element.append(spacer);
  });
  await page.waitForFunction(height => document.querySelector(".appScrollbarThumb").getBoundingClientRect().height < height, oldHeight);
  await view.evaluate(element => { document.querySelector("#scrollbar-test-spacer").style.height = "3000px"; element.scrollTop = 0; });
  await page.waitForFunction(height => document.querySelector(".appScrollbarThumb").getBoundingClientRect().height < height * 0.5, oldHeight);
  await view.evaluate(element => { element.replaceChildren(); });
  await page.waitForFunction(() => document.querySelector(".appScrollbarThumb").hidden);
  assert.equal(await rail.evaluate(element => getComputedStyle(element).visibility), "hidden");
  assert.deepEqual(errors, []);
  console.log("Scrollbar checks passed: stable thumb, fixed width, hidden native bars, home shelf arrows, eased wheels, direct dragging, track seeking, reduced motion and content resizing.");
} finally {
  await browser.close();
}
