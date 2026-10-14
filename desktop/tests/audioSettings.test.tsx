import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { Window as HappyWindow } from "happy-dom";
import { AudioSettingsProvider, useAudioSettings, type AudioSettingsApi } from "../src/hooks/AudioSettingsContext";
import { SettingsSidebar, type SettingsTab } from "../src/components/SettingsSidebar";
import { SettingsView } from "../src/components/SettingsView";
import { LibrarySourcesDialog } from "../src/components/LibrarySourcesDialog";
import { defaultAudioSettings, loadAudioSettings, parseAutoEq, saveAudioSettings, visibleOutputs } from "../src/utils/audioSettings";

const keys = ["window", "document", "HTMLElement", "HTMLInputElement", "Event", "MouseEvent", "IS_REACT_ACT_ENVIRONMENT"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let root: Root | null = null;
let mount: HTMLDivElement;
beforeAll(() => {
  keys.forEach(key => saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)));
  const browser = new HappyWindow({ url: "http://localhost" });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement, Event: browser.Event, MouseEvent: browser.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; mount?.remove(); globalThis.fetch = originalFetch; clearMocks(); });
afterAll(() => keys.forEach(key => { const descriptor = saved.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }));
function apiFor() {
  let stored = defaultAudioSettings();
  let reject = false;
  const api: AudioSettingsApi = { native: false, load: async () => structuredClone(stored), devices: async () => [],
    save: async next => { if (reject) throw new Error("Device refused settings"); stored = structuredClone(next); } };
  return { api, stored: () => stored, reject: () => { reject = true; } };
}
function Settings({ onServiceConnected = () => {} }: { onServiceConnected?: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("outputs");
  const [animateSwirl, setAnimateSwirl] = useState(true);
  return <><SettingsSidebar tab={tab} onSelect={setTab} onBack={() => {}} />
    <SettingsView onServiceConnected={onServiceConnected} tab={tab} onTabChange={setTab} showAudioQuality={false} onShowAudioQuality={() => {}} animateSwirl={animateSwirl} onAnimateSwirl={setAnimateSwirl} registerScrollElement={() => {}} /></>;
}
async function render(api: AudioSettingsApi, children = <Settings />) {
  mount = document.createElement("div"); document.body.append(mount); root = createRoot(mount);
  await act(async () => root!.render(<AudioSettingsProvider api={api}>{children}</AudioSettingsProvider>));
}
async function click(selector: string) { await act(async () => { mount.querySelector<HTMLElement>(selector)!.click(); }); }
async function press(text: string) {
  await act(async () => [...mount.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!.click());
}

test("settings sidebar navigates; presets save, assign, hide and delete without stale assignments", async () => {
  const state = apiFor(); await render(state.api);
  expect(mount.querySelector('.settingsSidebar [aria-current="page"]')?.textContent).toBe("Outputs");
  await click("#settings-tab-dsp");
  expect(mount.querySelector<HTMLElement>("#settings-panel-outputs")!.hidden).toBe(true);
  await press("New preset");
  await press("Add band");
  await press("Save preset");
  expect(state.stored().presets[0].name).toBe("New preset");
  expect(state.stored().presets[0].bands[0].frequency).toBe(1000);
  await click("#settings-tab-outputs");
  await act(async () => {
    const select = mount.querySelector<HTMLSelectElement>('[aria-label="DSP preset for System Default"]')!;
    select.value = state.stored().presets[0].id; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(state.stored().outputs[0].presetId).toBe(state.stored().presets[0].id);
  await click('[aria-label="Show System Default in player"]');
  expect(visibleOutputs(state.stored(), [])).toHaveLength(0);
  await press("Edit preset"); await press("Delete preset");
  expect(state.stored().presets).toHaveLength(0);
  expect(state.stored().outputs[0].presetId).toBeNull();
  await click("#settings-tab-general");
  expect(mount.querySelector<HTMLElement>("#settings-panel-general")!.hidden).toBe(false);
});

test("failed saves retain the accepted settings and show the error", async () => {
  const state = apiFor(); await render(state.api); state.reject();
  await click('[aria-label="Show System Default in player"]');
  expect(mount.querySelector<HTMLInputElement>('[aria-label="Show System Default in player"]')!.checked).toBe(true);
  expect(mount.querySelector('[role="alert"]')?.textContent).toContain("Device refused settings");
  expect(state.stored().outputs[0].enabled).toBe(true);
});

test("general settings allow turning swirl motion off and back on", async () => {
  await render(apiFor().api);
  await click("#settings-tab-general");
  const selector = '[aria-label="Animate swirl"]';
  expect(mount.querySelector<HTMLInputElement>(selector)!.checked).toBe(true);
  await click(selector);
  expect(mount.querySelector<HTMLInputElement>(selector)!.checked).toBe(false);
  await click(selector);
  expect(mount.querySelector<HTMLInputElement>(selector)!.checked).toBe(true);
});

test("Services checks connection status on entry and Spotify connects from Settings", async () => {
  const requests: string[] = [];
  let connected = 0;
  let spotify = false;
  globalThis.fetch = (async (url: string) => {
    requests.push(new URL(url).pathname);
    if (url.endsWith("/api/auth/status")) return Response.json({ tidal: true, qobuz: false, spotify });
    expect(url).toEndWith("/api/auth/spotify/start");
    spotify = true;
    return Response.json({ status: "connected", loginUrl: null });
  }) as typeof fetch;
  await render(apiFor().api, <Settings onServiceConnected={() => { connected++; }} />);
  expect(requests).toEqual([]);
  await click("#settings-tab-services");
  expect(mount.querySelector<HTMLElement>("#settings-panel-services")!.hidden).toBe(false);
  expect(mount.querySelector<HTMLButtonElement>('[aria-label="Tidal connected"]')!.disabled).toBe(true);
  await click('[aria-label="Sign in to Spotify"]');
  expect(mount.querySelector<HTMLButtonElement>('[aria-label="Spotify connected"]')!.disabled).toBe(true);
  expect(mount.querySelector("#settings-callback-url") === null).toBe(true);
  expect(connected).toBe(1);
  await click("#settings-tab-general");
  await click("#settings-tab-services");
  expect(requests).toEqual(["/api/auth/status", "/api/auth/spotify/start", "/api/auth/status"]);
});

for (const provider of ["tidal", "qobuz"] as const) {
  test(`${provider} browser callback connects through Services and survives switching settings tabs`, async () => {
    const loginUrl = `https://login.example/${provider}`;
    const callbackUrl = "http://localhost/callback?code=test-code";
    let connected = 0;
    const opened: unknown[] = [];
    mockIPC((command, payload) => {
      expect(command).toBe("plugin:opener|open_url");
      opened.push((payload as Record<string, unknown>)?.url);
    });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/auth/status")) return Response.json({ tidal: false, qobuz: false, spotify: false });
      expect(init?.method).toBe("POST");
      if (url.endsWith(`/api/auth/${provider}/start`)) return Response.json({ status: "callbackRequired", loginUrl });
      expect(url).toEndWith(`/api/auth/${provider}/complete`);
      expect(JSON.parse(String(init?.body))).toEqual({ callbackUrl });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await render(apiFor().api, <Settings onServiceConnected={() => { connected++; }} />);
    await click("#settings-tab-services");
    await click(`[aria-label="Sign in to ${provider === "tidal" ? "Tidal" : "Qobuz"}"]`);
    expect(opened).toEqual([loginUrl]);
    await click("#settings-tab-general");
    await click("#settings-tab-services");
    await act(async () => {
      const input = mount.querySelector<HTMLInputElement>("#settings-callback-url")!;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      // React's input-event fallback is selected when modules load before the test DOM.
      Object.assign(input, { attachEvent: () => {}, detachEvent: () => {} });
      input.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
      setter.call(input, callbackUrl);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true, key: "e" }));
    });
    await act(async () => mount.querySelector(".settingsCallbackForm")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mount.querySelector("#settings-callback-url") === null).toBe(true);
    expect(connected).toBe(1);
  });
}

test("failed service sign-in stays disconnected and can be retried", async () => {
  let connected = 0;
  globalThis.fetch = (async (url: string) => url.endsWith("/api/auth/status")
    ? Response.json({ tidal: false, qobuz: false, spotify: false })
    : Response.json({ error: "Spotify login failed" }, { status: 503 })) as typeof fetch;
  await render(apiFor().api, <Settings onServiceConnected={() => { connected++; }} />);
  await click("#settings-tab-services");
  await click('[aria-label="Sign in to Spotify"]');
  expect(mount.querySelector("#settings-panel-services [role=alert]")?.textContent).toContain("Spotify login failed");
  expect(mount.querySelector<HTMLButtonElement>('[aria-label="Sign in to Spotify"]')!.disabled).toBe(false);
  expect(connected).toBe(0);
});

test("Library's add dialog contains local import and scanning only", () => {
  const html = renderToStaticMarkup(<LibrarySourcesDialog onRescanLocalMusic={async () => 0} />);
  expect(html).toContain('aria-label="Add local music"');
  expect(html).toContain("Open folder");
  expect(html).toContain("Scan now");
  expect(html).not.toContain("Sign in");
  expect(html).not.toContain("Spotify");
  expect(html).not.toContain("Tidal");
  expect(html).not.toContain("Qobuz");
});

test("concurrent updates and device refresh preserve every accepted change", async () => {
  const state = apiFor(); let store: ReturnType<typeof useAudioSettings> = null;
  function Capture() { store = useAudioSettings(); return null; }
  await render(state.api, <Capture />);
  await act(async () => {
    await Promise.all([
      store!.update(current => ({ ...current, outputs: current.outputs.map(o => ({ ...o, name: "Speakers" })) })),
      store!.refresh(),
      store!.update(current => ({ ...current, outputs: current.outputs.map(o => ({ ...o, enabled: false })) })),
    ]);
  });
  expect(store!.settings.outputs[0]).toMatchObject({ name: "Speakers", enabled: false });
  expect(store!.settings).toEqual(state.stored());
});

test("AutoEq imports shelves and headroom; output selector excludes disconnected devices", () => {
  const imported = parseAutoEq("Preamp: -7.2 dB\nFilter 1: ON PK Fc 1000 Hz Gain -6 dB Q 1.4\nFilter 2: OFF LSC Fc 105 Hz Gain 5.5 dB Q 0.71");
  expect(imported.headroomDb).toBe(7.2);
  expect(imported.bands[1]).toMatchObject({ kind: "lowShelf", enabled: false, q: 0.71 });
  expect(() => parseAutoEq("Filter 1: ON LP Fc 1000 Hz Gain 0 dB Q 1")).toThrow();
  const settings = defaultAudioSettings();
  settings.outputs.push({ id: "offline", name: "DAC", enabled: true, exclusiveMode: true, resyncDelayMs: 0, presetId: null });
  expect(visibleOutputs(settings, []).map(o => o.id)).toEqual([""]);
});

async function setDelay(name: string, text: string) {
  await act(async () => {
    const input = mount.querySelector<HTMLInputElement>(`[aria-label="Resync delay for ${name}"]`)!;
    input.value = text;
    input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  });
}

test("resync delay saves independently for each device and allows zero", async () => {
  const state = apiFor();
  state.stored().outputs.push({ id: "dac", name: "DAC", enabled: true, exclusiveMode: true, resyncDelayMs: 0, presetId: null });
  await render(state.api);
  await setDelay("System Default", "725");
  await setDelay("DAC", "1500");
  expect(state.stored().outputs.map(output => output.resyncDelayMs)).toEqual([725, 1500]);
  await setDelay("DAC", "0");
  expect(state.stored().outputs.map(output => output.resyncDelayMs)).toEqual([725, 0]);
  expect(state.stored().presets).toEqual([]);
});

test("invalid delays and rejected saves do not replace a device's accepted value", async () => {
  const state = apiFor(); await render(state.api);
  for (const text of ["10001", "-1", "", "0.5"]) {
    await setDelay("System Default", text);
    expect(state.stored().outputs[0].resyncDelayMs).toBe(0);
  }
  state.reject();
  await setDelay("System Default", "500");
  expect(state.stored().outputs[0].resyncDelayMs).toBe(0);
  expect(mount.querySelector<HTMLInputElement>('[aria-label="Resync delay for System Default"]')!.value).toBe("0");
  expect(mount.querySelector('[role="alert"]')?.textContent).toContain("Device refused settings");
});

test("older saved outputs migrate delay to zero without losing DSP or assignments", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let text = JSON.stringify({ version: 1, selectedOutputId: "", outputs: [
    { id: "", name: "Speakers", enabled: true, exclusiveMode: true, presetId: "eq" },
  ], presets: [{ id: "eq", name: "Imported EQ", enabled: true, headroomDb: 7, outputGainDb: 0, bands: [], convolution: [] }] });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => text, setItem: (_key: string, value: string) => { text = value; } } });
  try {
    const settings = loadAudioSettings();
    expect(settings.outputs[0]).toMatchObject({ resyncDelayMs: 0, presetId: "eq", exclusiveMode: true });
    expect(settings.presets[0].name).toBe("Imported EQ");
    settings.outputs[0].resyncDelayMs = 1234;
    saveAudioSettings(settings);
    expect(loadAudioSettings().outputs[0].resyncDelayMs).toBe(1234);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
