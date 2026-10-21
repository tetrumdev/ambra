import type { MusicProvider } from "../types/music";
import { musicProviderName } from "../utils/musicProviderName";
import "./ProviderIcon.css";

/**
 * A service's logo in place of its name; the name stays available as alt text and a tooltip.
 * AMBRA's own playlists and local files are named in text rather than with the app's logo.
 */
export function ProviderIcon({ provider, label, className }: { provider: MusicProvider; label?: string; className?: string }) {
  const name = label ?? musicProviderName(provider);
  const classes = className ? `providerIcon ${className}` : "providerIcon";
  if (provider === "local") return <span className={`${classes} providerName`} data-provider={provider}>{name}</span>;
  return (
    <img
      className={classes}
      data-provider={provider}
      src={`/${provider}.svg`}
      alt={name}
      data-tooltip={name}
      draggable={false}
    />
  );
}
