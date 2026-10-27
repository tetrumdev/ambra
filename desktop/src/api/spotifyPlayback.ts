import { serverBaseUrl } from "./serverConnection";

export type SpotifyPlaybackBackend = "librespot" | "soloist";
export type SoloistQuality = "normal" | "high" | "very_high" | "lossless";
export type SoloistStatus = {
  backend: SpotifyPlaybackBackend;
  state: "not_installed" | "downloading" | "unsupported_platform" | "api_key_required" | "pairing_required" | "ready" | "playing" | "paused" | "buffering" | "updating" | "expired" | "error";
  build: { version: string; buildTimestamp: number; expiresAt: number; refreshAt: number } | null;
  needsRefresh: boolean;
  apiKeyPresent: boolean;
  paired: boolean;
  accountMatches: boolean | null;
  requestedQuality: SoloistQuality;
  capture: { available: boolean; reason: string };
  captureFormat: { codec: string; sampleFormat: string; sampleRate: number; channels: number };
  sourceFormatVerified: false;
  forwardingEnabled: boolean;
  automaticUpdatesSupported: boolean;
  preferredQuality: "high" | "lossless";
  effectiveRenderer: SpotifyPlaybackBackend | null;
  effectiveQuality: "high" | "lossless" | null;
  updateChecks: boolean;
  downloadsUrl: string;
  error: { code: string; message: string } | null;
};

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${serverBaseUrl}${path}`);
  const value = await response.json().catch(() => null) as T & { error?: string } | null;
  if (!response.ok) throw new Error(value?.error ?? `Spotify playback settings: HTTP ${response.status}`);
  if (!value) throw new Error("The server returned invalid Spotify playback status");
  return value;
}
export const spotifyPlaybackStatus = () => request<SoloistStatus>("/api/spotify/playback/status");
