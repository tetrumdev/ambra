import type { SearchProvider } from "../api/server";

export type AppScreen = "bigscreen" | "library" | "search" | "queue";

export type AppPreferences = {
  version: 4;
  ui: {
    screen: AppScreen;
  };
  search: {
    query: string;
    provider: SearchProvider;
  };
  playback: {
    trackId: string | null;
    positionSeconds: number;
  };
};

const preferencesKey = "ambra.preferences";
const legacyScreenKey = "ambra.current-screen";

export const defaultPreferences: AppPreferences = {
  version: 4,
  ui: {
    screen: "library",
  },
  search: {
    query: "",
    provider: "all",
  },
  playback: {
    trackId: null,
    positionSeconds: 0,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAppScreen(value: unknown): value is AppScreen {
  return (
    value === "bigscreen" ||
    value === "library" ||
    value === "search" ||
    value === "queue"
  );
}

function isSearchProvider(value: unknown): value is SearchProvider {
  return (
    value === "all" ||
    value === "tidal" ||
    value === "qobuz" ||
    value === "spotify"
  );
}

function migratePreferences(value: unknown): AppPreferences {
  if (!isRecord(value)) return defaultPreferences;

  const ui = isRecord(value.ui) ? value.ui : {};
  const screen = isAppScreen(ui.screen)
    ? ui.screen
    : defaultPreferences.ui.screen;

  switch (value.version) {
    case 1:
      return {
        version: 4,
        ui: { screen: screen === "search" ? "library" : screen },
        search: { ...defaultPreferences.search },
        playback: { ...defaultPreferences.playback },
      };
    case 2: {
      const playback = isRecord(value.playback) ? value.playback : {};
      const trackId =
        typeof playback.trackId === "string" && playback.trackId.length > 0
          ? playback.trackId
          : null;
      const positionSeconds =
        typeof playback.positionSeconds === "number" &&
        Number.isFinite(playback.positionSeconds) &&
        playback.positionSeconds >= 0
          ? playback.positionSeconds
          : 0;

      return {
        version: 4,
        ui: { screen: screen === "search" ? "library" : screen },
        search: { ...defaultPreferences.search },
        playback: { trackId, positionSeconds },
      };
    }
    case 3: {
      const search = isRecord(value.search) ? value.search : {};
      const query = typeof search.query === "string" ? search.query : "";
      const playback = isRecord(value.playback) ? value.playback : {};
      const trackId =
        typeof playback.trackId === "string" && playback.trackId.length > 0
          ? playback.trackId
          : null;
      const positionSeconds =
        typeof playback.positionSeconds === "number" &&
        Number.isFinite(playback.positionSeconds) &&
        playback.positionSeconds >= 0
          ? playback.positionSeconds
          : 0;

      return {
        version: 4,
        ui: {
          screen: screen === "search" && !query.trim() ? "library" : screen,
        },
        search: { query, provider: "all" },
        playback: { trackId, positionSeconds },
      };
    }
    case 4: {
      const search = isRecord(value.search) ? value.search : {};
      const query = typeof search.query === "string" ? search.query : "";
      const provider = isSearchProvider(search.provider)
        ? search.provider
        : defaultPreferences.search.provider;
      const playback = isRecord(value.playback) ? value.playback : {};
      const trackId =
        typeof playback.trackId === "string" && playback.trackId.length > 0
          ? playback.trackId
          : null;
      const positionSeconds =
        typeof playback.positionSeconds === "number" &&
        Number.isFinite(playback.positionSeconds) &&
        playback.positionSeconds >= 0
          ? playback.positionSeconds
          : 0;

      return {
        version: 4,
        ui: {
          screen: screen === "search" && !query.trim() ? "library" : screen,
        },
        search: { query, provider },
        playback: { trackId, positionSeconds },
      };
    }
    default:
      return defaultPreferences;
  }
}

export function loadPreferences(): AppPreferences {
  try {
    const savedPreferences = localStorage.getItem(preferencesKey);
    if (savedPreferences !== null) {
      return migratePreferences(JSON.parse(savedPreferences));
    }

    const legacyScreen = localStorage.getItem(legacyScreenKey);
    if (isAppScreen(legacyScreen)) {
      localStorage.removeItem(legacyScreenKey);
      return {
        ...defaultPreferences,
        ui: { screen: legacyScreen },
        search: { ...defaultPreferences.search },
        playback: { ...defaultPreferences.playback },
      };
    }
  } catch (error) {
    console.warn("Could not load saved preferences:", error);
  }

  return defaultPreferences;
}

export function savePreferences(preferences: AppPreferences) {
  try {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  } catch (error) {
    console.warn("Could not save preferences:", error);
  }
}
