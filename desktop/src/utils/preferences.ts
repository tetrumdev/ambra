import type { SearchProvider, StreamingProvider } from "../api/server";
import { getPersistentItem, removePersistentItem, setPersistentItem } from "./persistentStorage";
import { hideableTrackColumns, orderedOptionalColumns, type HideableColumnKey, type OptionalColumnKey } from "./trackColumnWidths";
import type { BrowseEntity } from "./browse";
import type { LibrarySection } from "../components/LibraryView";
import type { SettingsTab } from "../components/SettingsSidebar";

export type AppScreen = "bigscreen" | "lyrics" | "home" | "library" | "search" | "queue" | "settings";
export type LyricMotion = "system" | "full" | "reduced";
export type PlayerView = Extract<AppScreen, "bigscreen" | "lyrics">;
export type PlaylistGroup = "ambra" | "spotify" | "qobuz" | "tidal";

type NavigationPreferences = {
  playerReturnScreen: Exclude<AppScreen, "bigscreen" | "lyrics">;
  queueReturnScreen: Exclude<AppScreen, "bigscreen" | "lyrics" | "queue">;
  entity: BrowseEntity | null;
  playlistId: string | null;
  section: LibrarySection;
  settingsTab: SettingsTab;
};

export type AppPreferences = {
  version: 4;
  ui: {
    screen: AppScreen;
    showAudioQuality: boolean;
    animateSwirl: boolean;
    lyricMotion: LyricMotion;
    /** Detect and correct a constant lyric timing offset from the recording. */
    autoSyncLyrics: boolean;
    /** The player view to reopen: whichever of album art or lyrics was shown last. */
    playerView: PlayerView;
    /** The page behind the player and queue, restored with the last open screen. */
    navigation?: NavigationPreferences;
    playlistGroups: Record<PlaylistGroup, boolean>;
    servicePlaylistVisibility: Record<StreamingProvider, boolean>;
    /** Optional columns shown in every song list. */
    trackColumns: OptionalColumnKey[];
    /** Standard columns left out of every song list. */
    hiddenTrackColumns: HideableColumnKey[];
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
    screen: "home",
    showAudioQuality: false,
    animateSwirl: true,
    lyricMotion: "system",
    autoSyncLyrics: false,
    playerView: "bigscreen",
    playlistGroups: { ambra: true, spotify: true, qobuz: true, tidal: true },
    servicePlaylistVisibility: { spotify: true, qobuz: true, tidal: true },
    trackColumns: [],
    hiddenTrackColumns: [],
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
    value === "home" ||
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

function readNavigation(value: unknown): NavigationPreferences | undefined {
  if (!isRecord(value)) return undefined;
  const playerReturnScreen = isAppScreen(value.playerReturnScreen)
    && value.playerReturnScreen !== "bigscreen" && value.playerReturnScreen !== "lyrics"
    ? value.playerReturnScreen : "library";
  const queueReturnScreen = isAppScreen(value.queueReturnScreen)
    && value.queueReturnScreen !== "bigscreen" && value.queueReturnScreen !== "lyrics" && value.queueReturnScreen !== "queue"
    ? value.queueReturnScreen : "library";
  let entity: BrowseEntity | null = null;
  if (isRecord(value.entity)) {
    const candidate = value.entity.kind === "album" ? value.entity.album
      : value.entity.kind === "artist" ? value.entity.artist : null;
    if (isRecord(candidate) && typeof candidate.id === "string"
      && ["local", "tidal", "qobuz", "spotify"].includes(String(candidate.provider))
      && (candidate.imageUrl === null || typeof candidate.imageUrl === "string")
      && (value.entity.kind === "album"
        ? typeof candidate.title === "string" && typeof candidate.artist === "string"
        : typeof candidate.name === "string")) {
      entity = value.entity as BrowseEntity;
    }
  }
  return {
    playerReturnScreen,
    queueReturnScreen,
    entity,
    playlistId: typeof value.playlistId === "string" ? value.playlistId : null,
    section: value.section === "artists" || value.section === "albums" || value.section === "tracks" ? value.section : "overview",
    settingsTab: value.settingsTab === "outputs" || value.settingsTab === "dsp" || value.settingsTab === "services" || value.settingsTab === "local"
      ? value.settingsTab : "general",
  };
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
  const autoSyncLyrics = typeof ui.autoSyncLyrics === "boolean"
    ? ui.autoSyncLyrics
    : defaultPreferences.ui.autoSyncLyrics;
  const playerView: PlayerView = ui.playerView === "lyrics" ? "lyrics" : "bigscreen";
  const navigation = readNavigation(ui.navigation);
  const playlistGroups = { ...defaultPreferences.ui.playlistGroups };
  if (isRecord(ui.playlistGroups)) {
    for (const group of ["ambra", "spotify", "qobuz", "tidal"] as const) {
      if (typeof ui.playlistGroups[group] === "boolean") playlistGroups[group] = ui.playlistGroups[group];
    }
  }
  const servicePlaylistVisibility = { ...defaultPreferences.ui.servicePlaylistVisibility };
  if (isRecord(ui.servicePlaylistVisibility)) {
    for (const provider of ["spotify", "qobuz", "tidal"] as const) {
      if (typeof ui.servicePlaylistVisibility[provider] === "boolean") {
        servicePlaylistVisibility[provider] = ui.servicePlaylistVisibility[provider];
      }
    }
  }

  const trackColumns = Array.isArray(ui.trackColumns)
    ? orderedOptionalColumns(ui.trackColumns.filter((key): key is string => typeof key === "string")).map(column => column.key)
    : [];

  const hiddenTrackColumns = Array.isArray(ui.hiddenTrackColumns)
    ? hideableTrackColumns.filter(key => (ui.hiddenTrackColumns as unknown[]).includes(key))
    : [];

  switch (value.version) {
    case 1:
      return {
        version: 4,
        ui: { screen: screen === "search" ? "library" : screen, showAudioQuality, animateSwirl, lyricMotion, autoSyncLyrics, playerView, navigation, playlistGroups, servicePlaylistVisibility, trackColumns, hiddenTrackColumns },
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
        ui: { screen: screen === "search" ? "library" : screen, showAudioQuality, animateSwirl, lyricMotion, autoSyncLyrics, playerView, navigation, playlistGroups, servicePlaylistVisibility, trackColumns, hiddenTrackColumns },
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
          autoSyncLyrics,
          playerView,
          navigation,
          playlistGroups,
          servicePlaylistVisibility,
          trackColumns,
          hiddenTrackColumns,
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
          autoSyncLyrics,
          playerView,
          navigation,
          playlistGroups,
          servicePlaylistVisibility,
          trackColumns,
          hiddenTrackColumns,
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

/** Saves everything but playback, which follows the clock through savePlayback instead. */
export function savePreferences(preferences: AppPreferences) {
  try {
    const { playback, ...localPreferences } = preferences;
    setPersistentItem(preferencesKey, JSON.stringify(localPreferences));
  } catch (error) {
    console.warn("Could not save preferences:", error);
  }
}

export function savePlayback(playback: AppPreferences["playback"]) {
  try {
    setPersistentItem(playbackKey, JSON.stringify(playback));
  } catch (error) {
    console.warn("Could not save playback:", error);
  }
}
