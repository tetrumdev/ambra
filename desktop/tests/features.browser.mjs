import assert from "node:assert/strict";

const { chromium } = await import(process.env.AMBRA_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const heading = async title => page.getByRole("heading", { name: title, exact: true }).waitFor();
const rows = () => page.locator(".playlistView .libraryItem");
const filter = () => page.getByRole("textbox", { name: "Filter songs on this page" });
const volume = async () => (await page.locator(".volumePercentage").innerText()).trim();
const left = async locator => (await locator.boundingBox()).x;
try {
  await page.goto(`${process.env.AMBRA_FEATURES_PREVIEW_URL ?? "http://127.0.0.1:1420"}/tests/features.html`);
  await heading("Welcome Back");

  // / does nothing on a page without a song list.
  await page.keyboard.press("Slash");
  assert.equal(await filter().count(), 0);

  await page.locator("#sidebarMain").getByRole("button", { name: "Feature Mix", exact: true }).click();
  await heading("Feature Mix");
  await rows().nth(2).waitFor();

  // The page filter ignores accents, counts matches, and typing F in it leaves the player closed.
  await page.keyboard.press("Slash");
  await filter().waitFor();
  assert.equal(await filter().evaluate(input => input === document.activeElement), true);
  await page.keyboard.type("beyonce f");
  assert.equal(await page.getByRole("button", { name: "Close player" }).count(), 0);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.locator(".pageFilterCount", { hasText: "1 song" }).waitFor();
  // The page's only match stays among its neighbours, pointed out rather than narrowed to.
  assert.equal(await rows().count(), 3);
  assert.match(await page.locator('.playlistView .libraryItem[data-revealed="true"]').innerText(), /Halo/);
  await filter().fill("nothing like this");
  await page.locator(".pageFilterCount", { hasText: "No matches" }).waitFor();
  await page.keyboard.press("Escape");
  await filter().waitFor({ state: "detached" });
  await heading("Feature Mix");
  assert.equal(await rows().count(), 3);

  // Optional columns sit between the album and the duration, lined up with their rows.
  await page.getByRole("button", { name: "Choose columns" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Year" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Plays" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Quality" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("menu", { name: "Columns" }).waitFor({ state: "detached" });
  const halo = rows().filter({ hasText: "Halo" });
  assert.equal(await halo.locator(".yearColumnCell").innerText(), "2008");
  assert.equal(await halo.locator(".playsColumnCell").innerText(), "7");
  assert.equal(await halo.locator(".qualityColumnCell").innerText(), "FLAC 16/44.1");
  const header = page.locator(".playlistView .columnInfo");
  const order = [
    await left(header.locator(".albumColumn")), await left(header.locator(".qualityColumn")),
    await left(header.locator(".yearColumn")), await left(header.locator(".playsColumn")), await left(header.locator(".durationColumn")),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order, `header columns out of order: ${order}`);
  assert.ok(Math.abs(await left(halo.locator(".yearColumnCell")) - order[2]) < 2, "year cells line up with their header");
  assert.ok(Math.abs(await left(halo.locator(".trackDuration")) - order[4]) < 2, "durations line up with their header");
  // Reading low to high, the only played song comes last.
  await header.getByRole("button", { name: "Sort Plays descending" }).click();
  assert.match(await rows().last().innerText(), /Halo/);
  if (process.env.AMBRA_FEATURES_SCREENSHOTS) await page.screenshot({ path: `${process.env.AMBRA_FEATURES_SCREENSHOTS}/columns.png` });

  // Album pages hide the artist and album columns; the optional ones follow the title instead.
  // The fixture has no album with songs, so this lays out an album page's header and row directly.
  const album = await page.evaluate(() => {
    const view = document.createElement("div");
    view.className = "libraryView albumView";
    view.style.cssText = "position:fixed;top:0;left:0;width:900px;height:auto;z-index:99";
    view.innerHTML = `
      <div class="columnInfo"><span class="columnLeadingSpacer"></span>
        <div class="trackColumn columnHeaderCell">Track</div><div class="artistColumn columnHeaderCell">Artist</div>
        <div class="albumColumn columnHeaderCell">Album</div><div class="qualityColumn columnHeaderCell extraColumn">Quality</div>
        <div class="yearColumn columnHeaderCell extraColumn">Year</div><div class="playsColumn columnHeaderCell extraColumn">Plays</div>
        <div class="durationColumn columnHeaderCell">Duration</div><div class="columnPicker"></div></div>
      <div class="libraryItem"><div class="trackLeading"></div><span class="trackName trackDescriptor">Halo</span>
        <span class="artistName trackDescriptor">Beyoncé</span><span class="albumName trackDescriptor">Album</span>
        <span class="extraCell qualityColumnCell trackDescriptor">FLAC</span><span class="extraCell yearColumnCell trackDescriptor">2008</span>
        <span class="extraCell playsColumnCell trackDescriptor">7</span><span class="trackDuration trackDescriptor">3:20</span>
        <button class="trackCollectionMenuTrigger"></button></div>`;
    document.body.append(view);
    const x = selector => view.querySelector(selector).getBoundingClientRect().x;
    const result = {
      header: ["trackColumn", "qualityColumn", "yearColumn", "playsColumn", "durationColumn"].map(name => x(`.columnInfo .${name}`)),
      row: ["trackName", "qualityColumnCell", "yearColumnCell", "playsColumnCell", "trackDuration"].map(name => x(`.libraryItem .${name}`)),
      menu: x(".trackCollectionMenuTrigger") + view.querySelector(".trackCollectionMenuTrigger").getBoundingClientRect().width,
      width: view.querySelector(".libraryItem").getBoundingClientRect().right,
    };
    view.remove();
    return result;
  });
  assert.deepEqual([...album.header].sort((a, b) => a - b), album.header, `album header out of order: ${album.header}`);
  album.header.forEach((x, index) => assert.ok(Math.abs(x - album.row[index]) < 2, `album column ${index} lines up: ${album.header} / ${album.row}`));
  assert.ok(Math.abs(album.menu - album.width) < 2, "the menu stays in the last column");

  // The queue filters each of its sections.
  await page.keyboard.press("KeyQ");
  await page.locator("main#queue").waitFor();
  await page.keyboard.press("Slash");
  await filter().fill("queen");
  await page.locator(".pageFilterCount", { hasText: "1 song" }).waitFor();
  await filter().fill("halo");
  await page.locator(".pageFilterCount", { hasText: "No matches" }).waitFor();
  await page.keyboard.press("Enter");
  // Enter hands the keyboard back; the filter stays until it is closed.
  await filter().waitFor();
  if (process.env.AMBRA_FEATURES_SCREENSHOTS) await page.screenshot({ path: `${process.env.AMBRA_FEATURES_SCREENSHOTS}/queue-filter.png` });
  await page.getByRole("button", { name: "Close filter" }).click();
  await filter().waitFor({ state: "detached" });
  await page.keyboard.press("KeyQ");

  // Volume: arrows step 5%, M mutes and restores, the wheel glides.
  assert.equal(await volume(), "100%");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.locator(".volumePercentage", { hasText: "90%" }).waitFor();
  await page.keyboard.press("KeyM");
  await page.locator(".volumePercentage", { hasText: /^0%$/ }).waitFor();
  assert.equal(await page.locator("#volumeImg").getAttribute("data-level"), "muted");
  await page.keyboard.press("KeyM");
  await page.locator(".volumePercentage", { hasText: "90%" }).waitFor();
  await page.locator("#volumeBtn").hover();
  await page.mouse.wheel(0, 100);
  await page.locator(".volumePercentage", { hasText: "85%" }).waitFor();
  await page.mouse.wheel(0, -20);
  await page.locator(".volumePercentage", { hasText: "86%" }).waitFor();

  // Normalization lives in Settings and needs the desktop app's audio engine.
  await page.keyboard.press("Control+Comma");
  await page.getByRole("button", { name: "General", exact: true }).click();
  const normalization = page.getByRole("switch", { name: "Volume normalization" });
  await normalization.waitFor();
  assert.equal(await normalization.isDisabled(), true);
  await page.getByRole("heading", { name: "Updates", exact: true }).waitFor();

  // DSP: add a band on the graph, nudge it from the keyboard, let the warning fix headroom, save.
  await page.locator("#settings-tab-dsp").click();
  await page.locator(".dspEmpty").getByRole("button", { name: "New preset" }).click();
  const graph = await page.locator(".eqGraph svg").boundingBox();
  await page.mouse.dblclick(graph.x + graph.width * 0.5, graph.y + graph.height * 0.3);
  const node = page.locator('[data-band="0"]');
  await node.waitFor();
  const before = await page.getByRole("spinbutton", { name: "Gain band 1" }).inputValue();
  const volumeBefore = await volume();
  await node.focus();
  await page.keyboard.press("ArrowUp");
  assert.equal(Number(await page.getByRole("spinbutton", { name: "Gain band 1" }).inputValue()), Number(before) + 0.5);
  assert.equal(await volume(), volumeBefore, "arrow keys on a band don't change the volume");
  await page.locator(".dspWarning").getByRole("button").click();
  await page.locator(".dspWarning").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Save preset" }).click();
  await page.getByRole("region", { name: "Unsaved changes" }).waitFor({ state: "detached" });
  await page.locator(".dspPresetItem", { hasText: "1 bands" }).waitFor();

  assert.deepEqual(errors, []);
  console.log("Browser checks passed: page filter, optional columns and sorting, volume keys, mute and wheel, normalization and update settings.");
} catch (error) {
  console.error({ errors, text: await page.locator("body").innerText() });
  throw error;
} finally {
  await browser.close();
}
