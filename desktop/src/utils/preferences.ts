export type AppScreen = "bigscreen" | "library" | "search" | "queue";

export type AppPreferences = {
  version: 2;
  ui: {
    screen: AppScreen;
  };
  playback: {
    trackId: string | null;
    positionSeconds: number;
  };
};

const preferencesKey = "ambra.preferences";
const legacyScreenKey = "ambra.current-screen";

export const defaultPreferences: AppPreferences = {
  version: 2,
  ui: {
    screen: "library",
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

function migratePreferences(value: unknown): AppPreferences {
  if (!isRecord(value)) return defaultPreferences;

  const ui = isRecord(value.ui) ? value.ui : {};
  const screen = isAppScreen(ui.screen)
    ? ui.screen
    : defaultPreferences.ui.screen;

  switch (value.version) {
    case 1:
      return {
        version: 2,
        ui: { screen },
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
        version: 2,
        ui: { screen },
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
