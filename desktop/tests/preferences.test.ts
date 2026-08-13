import { beforeEach, describe, expect, test } from "bun:test";
import {
  loadPreferences,
  savePreferences,
  type AppPreferences,
} from "../src/utils/preferences";

const storedValues = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => storedValues.set(key, value),
    removeItem: (key: string) => storedValues.delete(key),
    clear: () => storedValues.clear(),
    key: (index: number) => [...storedValues.keys()][index] ?? null,
    get length() {
      return storedValues.size;
    },
  } satisfies Storage,
});

describe("preferences", () => {
  beforeEach(() => storedValues.clear());

  test("saves and restores the active search", () => {
    const preferences: AppPreferences = {
      version: 3,
      ui: { screen: "search" },
      search: { query: "Blackest Eyes", provider: "qobuz" },
      playback: { trackId: null, positionSeconds: 0 },
    };

    savePreferences(preferences);

    expect(loadPreferences()).toEqual(preferences);
  });

  test("does not restore an old search screen without a saved query", () => {
    localStorage.setItem(
      "ambra.preferences",
      JSON.stringify({
        version: 2,
        ui: { screen: "search" },
        playback: { trackId: "tidal:123", positionSeconds: 12 },
      }),
    );

    expect(loadPreferences()).toEqual({
      version: 3,
      ui: { screen: "library" },
      search: { query: "", provider: "tidal" },
      playback: { trackId: "tidal:123", positionSeconds: 12 },
    });
  });
});
