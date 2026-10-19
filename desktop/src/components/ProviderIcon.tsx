import type { MusicProvider } from "../types/music";
import { musicProviderName } from "../utils/musicProviderName";
import "./ProviderIcon.css";

/** A service's logo in place of its name; the name stays available as alt text and a tooltip. */
export function ProviderIcon({ provider, label, className }: { provider: MusicProvider; label?: string; className?: string }) {
  const name = label ?? musicProviderName(provider);
  return (
    <img
      className={className ? `providerIcon ${className}` : "providerIcon"}
      data-provider={provider}
      src={provider === "local" ? "/ambra.svg" : `/${provider}Icon.svg`}
      alt={name}
      data-tooltip={name}
      draggable={false}
    />
  );
}
