import assert from "node:assert/strict";

const { chromium } = await import(process.env.AMBRA_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  const methods = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    if (!new URL(route.request().url()).pathname.startsWith("/api/")) return route.continue();
    methods.push(route.request().method());
    return route.abort("connectionrefused");
  });
  await page.goto(process.env.AMBRA_SERVER_SETUP_PREVIEW_URL ?? "http://127.0.0.1:1431");
  await page.getByRole("heading", { name: "Connect to your music server", exact: true }).waitFor({ timeout: 8000 }).catch(async error => {
    console.error({ errors, body: await page.locator("body").innerText() });
    throw error;
  });
  assert.equal(await page.locator("code", { hasText: "ambra-server start" }).count(), 1);
  await page.getByRole("button", { name: "Reconnect", exact: true }).waitFor();
  assert.equal(await page.locator("#nowPlayingBar").count(), 0);
  assert.ok(methods.every(method => method === "GET"), "An unavailable server must not cause local state to be uploaded");
  assert.deepEqual(errors, []);
  await page.addInitScript(() => {
    window.isTauri = true;
    window.serverCommands = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async command => {
        window.serverCommands.push(command);
        if (command === "server_connection") return { mode: "host", baseUrl: "http://127.0.0.1:38147", token: null, fallback: false, server: null, whenAway: "wait", decided: false, clientName: "Test", clientId: "test" };
        if (command === "discover_servers") return [];
        if (command === "start_local_server") return "Server running in the background";
        if (command === "plugin:event|listen") return 1;
        return null;
      },
    };
  });
  await page.reload();
  const start = page.getByRole("button", { name: "Start server on this computer", exact: true });
  await start.waitFor();
  assert.equal(await page.evaluate(() => window.serverCommands.includes("start_local_server")), false, "Opening the app never starts the server automatically");
  await start.click();
  await page.waitForFunction(() => window.serverCommands.includes("restart_app"));
  assert.equal(await page.evaluate(() => window.serverCommands.filter(command => command === "start_local_server").length), 1);
  assert.deepEqual(errors, []);
  console.log("Connection screen passes: explicit start command, reconnect, no independent playback or state writes.");
} finally {
  await browser.close();
}
