import { useEffect, useRef, useState } from "react";
import { serviceAuthStatus, type ServiceAuthStatus } from "../api/server";
import { updateServiceAvailability } from "../hooks/useServiceAvailability";
import { useClientConnection } from "../hooks/ClientConnectionContext";
import { SpotifyPlaybackSettings } from "./SpotifyPlaybackSettings";

type Props = { active: boolean; onServiceConnected: () => void };
/** Provider accounts and credentials are managed exclusively by the independent server CLI. */
export function ServiceSettings({ active, onServiceConnected }: Props) {
  const { connected } = useClientConnection();
  const callback = useRef(onServiceConnected);
  callback.current = onServiceConnected;
  const previous = useRef<ServiceAuthStatus | null>(null);
  const [status, setStatus] = useState<ServiceAuthStatus | null>(null);
  useEffect(() => {
    if (!active || !connected) return;
    let disposed = false;
    const refresh = () => void serviceAuthStatus().then(value => {
      if (disposed) return;
      const changed = !previous.current || (["tidal", "qobuz", "spotify"] as const).some(provider => previous.current![provider] !== value[provider]);
      if (!changed) return;
      previous.current = value;
      setStatus(value); updateServiceAvailability(value); callback.current();
    }).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [active, connected]);
  return <>
    <header className="settingsPageHeader"><h1 className="settingsTitle">Services</h1></header>
    <p className="settingsMuted">Manage provider accounts on your server with its CLI. Credentials stay on the server.</p>
    {!connected && <p className="settingsMuted">Connect through Settings → Server to use streaming services.</p>}
    {(["tidal", "qobuz", "spotify"] as const).map(provider => <div className="settingsGroup" key={provider}>
      <h2>{provider === "tidal" ? "Tidal" : provider === "qobuz" ? "Qobuz" : "Spotify"}</h2>
      <p role="status">{connected && status?.[provider] ? "Connected on server" : "Unavailable"}</p>
      <code>ambra-server login {provider}</code>
    </div>)}
    <SpotifyPlaybackSettings active={active && connected} connected={connected} />
  </>;
}
