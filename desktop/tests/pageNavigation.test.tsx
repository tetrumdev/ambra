import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { usePageNavigation, type AppPage } from "../src/hooks/usePageNavigation";
import { SettingsSidebar } from "../src/components/SettingsSidebar";

const dom = new Window({ url: "http://localhost/" });
beforeAll(() => {
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  });
});
afterAll(() => { dom.happyDOM.abort(); });

const home: AppPage = {
  screen: "home", entity: null, playlistId: null, section: "tracks",
  settingsTab: "general", search: { query: "saved query", provider: "qobuz" },
};
const origins: AppPage[] = [
  home,
  { ...home, screen: "search" },
  { ...home, screen: "library", section: "albums" },
  { ...home, screen: "library", section: "artists" },
  { ...home, screen: "library", playlistId: "saved-playlist" },
  { ...home, screen: "library", entity: { kind: "album", album: {
    id: "qobuz:album", provider: "qobuz", title: "Saved album", artist: "Artist", imageUrl: null,
  } } },
  { ...home, screen: "library", entity: { kind: "artist", artist: {
    id: "qobuz:artist", provider: "qobuz", name: "Saved artist", imageUrl: null,
  } } },
];

for (const origin of origins) {
  const name = origin.entity?.kind ?? origin.playlistId ?? (origin.screen === "library" ? origin.section : origin.screen);
  test(`Settings Back restores ${name} and its context after changing tabs`, async () => {
    let current!: AppPage;
    let visit!: (page: AppPage) => void;
    let navigation!: ReturnType<typeof usePageNavigation>;
    function Harness() {
      const [page, setPage] = useState(origin);
      current = page;
      visit = setPage;
      navigation = usePageNavigation(page, setPage);
      return page.screen === "settings" ? <SettingsSidebar
        tab={page.settingsTab}
        onSelect={settingsTab => setPage(current => ({ ...current, settingsTab }))}
        onBack={() => navigation.back()}
      /> : <div>{page.screen}</div>;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Harness />));
      await act(async () => visit({ ...origin, screen: "settings", entity: null, playlistId: null }));
      for (const tab of ["outputs", "dsp", "services"]) {
        await act(async () => container.querySelector<HTMLButtonElement>(`#settings-tab-${tab}`)!.click());
      }
      expect(current.screen).toBe("settings");
      expect(current.settingsTab).toBe("services");
      await act(async () => container.querySelector<HTMLButtonElement>(".settingsBack")!.click());
      expect(current).toEqual(origin);
      expect(navigation.canGo("back")).toBe(false);
      expect(navigation.canGo("forward")).toBe(true);
      await act(async () => { expect(navigation.forward()).toBe(true); });
      expect(current.screen).toBe("settings");
      expect(current.settingsTab).toBe("services");
      await act(async () => { expect(navigation.back()).toBe(true); });
      expect(current).toEqual(origin);
    } finally {
      await act(async () => root.unmount());
    }
  });
}
