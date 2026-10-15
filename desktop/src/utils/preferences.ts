import type { SearchProvider } from "../api/server";
import { getPersistentItem, removePersistentItem, setPersistentItem } from "./persistentStorage";

export type AppScreen = "bigscreen" | "lyrics" | "library" | "search" | "queue" | "settings";
export type LyricMotion = "system" | "full" | "reduced";

export type AppPreferences = {
  version: 4;
  ui: {
    screen: AppScreen;
    showAudioQuality: boolean;
    animateSwirl: boolean;
    lyricMotion: LyricMotion;
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

const preferencesKey = "ambra.ui-preferences.v1";
const playbackKey = "ambra.playback.v1";
const legacyScreenKey = "ambra.current-screen";

export const defaultPreferences: AppPreferences = {
  version: 4,
  ui: {
    screen: "library",
    showAudioQuality: false,
    animateSwirl: true,
    lyricMotion: "system",
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
    value === "lyrics" ||
    value === "library" ||
    value === "search" ||
    value === "queue" ||
    value === "settings"
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
  const showAudioQuality = typeof ui.showAudioQuality === "boolean"
    ? ui.showAudioQuality
    : defaultPreferences.ui.showAudioQuality;
  const animateSwirl = typeof ui.animateSwirl === "boolean"
    ? ui.animateSwirl
    : defaultPreferences.ui.animateSwirl;
  const lyricMotion = ui.lyricMotion === "full" || ui.lyricMotion === "reduced"
    ? ui.lyricMotion
    : "system";

  switch (value.version) {
    case 1:
      return {
        version: 4,
        ui: { screen: screen === "search" ? "library" : screen, showAudioQuality, animateSwirl, lyricMotion },
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
        ui: { screen: screen === "search" ? "library" : screen, showAudioQuality, animateSwirl, lyricMotion },
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
          showAudioQuality,
          animateSwirl,
          lyricMotion,
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
          showAudioQuality,
          animateSwirl,
          lyricMotion,
        },
        search: { query, provider },
        playback: { trackId, positionSeconds },
      };
    }
    default:
      return defaultPreferences;
  }
}

function loadLocalPreferences(): AppPreferences {
  try {
    const savedPreferences = getPersistentItem(preferencesKey) ?? getPersistentItem("ambra.preferences");
    if (savedPreferences !== null) {
      return migratePreferences(JSON.parse(savedPreferences));
    }

    const legacyScreen = getPersistentItem(legacyScreenKey);
    if (isAppScreen(legacyScreen)) {
      removePersistentItem(legacyScreenKey);
      return {
        ...defaultPreferences,
        ui: { ...defaultPreferences.ui, screen: legacyScreen },
        search: { ...defaultPreferences.search },
        playback: { ...defaultPreferences.playback },
      };
    }
  } catch (error) {
    console.warn("Could not load saved preferences:", error);
  }

  return defaultPreferences;
}

export function loadPreferences(): AppPreferences {
  const preferences = loadLocalPreferences();
  const playback = JSON.parse(getPersistentItem(playbackKey) ?? "null") as AppPreferences["playback"] | null;
  return { ...preferences, playback: playback ?? { ...defaultPreferences.playback } };
}

export function savePreferences(preferences: AppPreferences) {
  try {
    const { playback, ...localPreferences } = preferences;
    setPersistentItem(preferencesKey, JSON.stringify(localPreferences));
    setPersistentItem(playbackKey, JSON.stringify(playback));
  } catch (error) {
    console.warn("Could not save preferences:", error);
  }
}
