import { serverBaseUrl } from "./serverConnection";

export type SpotifyPlaybackBackend = "librespot" | "soloist";
export type SoloistQuality = "normal" | "high" | "very_high" | "lossless";
export type SoloistStatus = {
  backend: SpotifyPlaybackBackend;
  state: "not_installed" | "unsupported_platform" | "api_key_required" | "pairing_required" | "ready" | "playing" | "paused" | "buffering" | "updating" | "expired" | "error";
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
  automaticUpdatesSupported: false;
  updateChecks: boolean;
  fallback: "never" | "librespot_before_start";
  downloadsUrl: string;
  error: { code: string; message: string } | null;
};

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`${serverBaseUrl}${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => null) as T & { error?: string } | null;
  if (!response.ok) throw new Error(value?.error ?? `Spotify playback settings: HTTP ${response.status}`);
  if (!value) throw new Error("The server returned invalid Spotify playback status");
  return value;
}
export const spotifyPlaybackStatus = () => request<SoloistStatus>("/api/spotify/playback/status");
export const spotifyPlaybackSettings = () => request<{ status: SoloistStatus; executable: string | null }>("/api/local/spotify/playback");
export const saveSpotifyPlayback = (change: {
  backend: SpotifyPlaybackBackend; executable?: string; apiKey?: string; quality: SoloistQuality; updateChecks: boolean; fallback: SoloistStatus["fallback"];
}) => request<SoloistStatus>("/api/local/spotify/playback", change);
export const soloistAction = (action: "pair" | "reset" | "sign-out" | "check" | "install", executable?: string) =>
  request<SoloistStatus>(`/api/local/spotify/soloist/${action}`, executable ? { executable } : {});

export function canManageSpotifyPlayback() {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(serverBaseUrl).hostname); }
  catch { return false; }
}
