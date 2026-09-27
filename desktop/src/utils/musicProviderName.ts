import type { MusicProvider } from "../types/music";

const names: Record<MusicProvider, string> = {
  local: "Local",
  tidal: "Tidal",
  qobuz: "Qobuz",
  spotify: "Spotify",
};

export function musicProviderName(provider: MusicProvider): string {
  return names[provider];
}
