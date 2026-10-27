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
    /** Instant transitions across the app; independent of the system's animation setting. */
    reduceMotion: boolean;
    animateSwirl: boolean;
    lyricMotion: LyricMotion;
    /** Detect and correct a constant lyric timing offset from the recording. */
    autoSyncLyrics: boolean;
    /** Shown this much earlier (positive) or later on every song, for a delay in the output itself. */
    lyricsOffsetMs: number;
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

export const preferencesKey = "ambra.ui-preferences.v1";
export const MAX_LYRICS_OFFSET_MS = 5_000;
const playbackKey = "ambra.playback.v1";
/** Never sent to the server (see `withDeviceView`). */
const deviceViewKey = "ambra.device-view.v1";
const legacyScreenKey = "ambra.current-screen";

export const defaultPreferences: AppPreferences = {
  version: 4,
  ui: {
    screen: "home",
    showAudioQuality: false,
    reduceMotion: false,
    animateSwirl: true,
    lyricMotion: "system",
    autoSyncLyrics: false,
    lyricsOffsetMs: 0,
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
  const reduceMotion = typeof ui.reduceMotion === "boolean"
    ? ui.reduceMotion
    : defaultPreferences.ui.reduceMotion;
  const animateSwirl = typeof ui.animateSwirl === "boolean"
    ? ui.animateSwirl
    : defaultPreferences.ui.animateSwirl;
  const lyricMotion = ui.lyricMotion === "full" || ui.lyricMotion === "reduced"
    ? ui.lyricMotion
    : "system";
  const autoSyncLyrics = typeof ui.autoSyncLyrics === "boolean"
    ? ui.autoSyncLyrics
    : defaultPreferences.ui.autoSyncLyrics;
  const lyricsOffsetMs = typeof ui.lyricsOffsetMs === "number" && Number.isFinite(ui.lyricsOffsetMs)
    ? Math.round(Math.max(-MAX_LYRICS_OFFSET_MS, Math.min(MAX_LYRICS_OFFSET_MS, ui.lyricsOffsetMs)))
    : 0;
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
        ui: { screen: screen === "search" ? "library" : screen, showAudioQuality, reduceMotion, animateSwirl, lyricMotion, autoSyncLyrics, lyricsOffsetMs, playerView, navigation, playlistGroups, servicePlaylistVisibility, trackColumns, hiddenTrackColumns },
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
        ui: { screen: screen === "search" ? "library" : screen, showAudioQuality, reduceMotion, animateSwirl, lyricMotion, autoSyncLyrics, lyricsOffsetMs, playerView, navigation, playlistGroups, servicePlaylistVisibility, trackColumns, hiddenTrackColumns },
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
          reduceMotion,
          animateSwirl,
          lyricMotion,
          autoSyncLyrics,
          lyricsOffsetMs,
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
          reduceMotion,
          animateSwirl,
          lyricMotion,
          autoSyncLyrics,
          lyricsOffsetMs,
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

/**
 * Where this device left off, kept on it alone: another device opening the same server starts
 * where it left off, not here. Settings and playback remain owned by this device.
 */
function withDeviceView(preferences: AppPreferences): AppPreferences {
  try {
    const saved = localStorage.getItem(deviceViewKey);
    if (saved === null) return preferences;
    const view = migratePreferences(JSON.parse(saved));
    const { screen, playerView, navigation, playlistGroups } = view.ui;
    return { ...preferences, ui: { ...preferences.ui, screen, playerView, navigation, playlistGroups }, search: view.search };
  } catch {
    return preferences;
  }
}

/** Settings another device just changed, under this device's own view of the app. */
export function withSyncedSettings(current: AppPreferences): AppPreferences {
  const { screen, playerView, navigation, playlistGroups } = current.ui;
  return { ...current, ui: { ...loadLocalPreferences().ui, screen, playerView, navigation, playlistGroups } };
}

export function loadPreferences(): AppPreferences {
  const preferences = withDeviceView(loadLocalPreferences());
  const playback = JSON.parse(getPersistentItem(playbackKey) ?? "null") as AppPreferences["playback"] | null;
  return { ...preferences, playback: playback ?? { ...defaultPreferences.playback } };
}

/** Saves everything but playback, which follows the clock through savePlayback instead. */
export function savePreferences(preferences: AppPreferences) {
  try {
    const { version, search } = preferences;
    const { screen, playerView, navigation, playlistGroups, ...settings } = preferences.ui;
    setPersistentItem(preferencesKey, JSON.stringify({ version, ui: settings }));
    setPersistentItem(deviceViewKey, JSON.stringify({ version, ui: { screen, playerView, navigation, playlistGroups }, search }));
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
