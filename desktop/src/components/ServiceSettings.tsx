import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { serviceAuthStatus, type ServiceAuthStatus, type StreamingProvider } from "../api/server";
import { getServerConnection, subscribeServerConnection } from "../api/serverConnection";
import { signInService } from "../utils/serviceSignIn";
import { updateServiceAvailability } from "../hooks/useServiceAvailability";
import { useClientConnection } from "../hooks/ClientConnectionContext";
import { SpotifyPlaybackSettings } from "./SpotifyPlaybackSettings";

type Props = { active: boolean; onServiceConnected: () => void };
/** Browser sign-in runs on this computer; provider credentials remain on the independent server. */
export function ServiceSettings({ active, onServiceConnected }: Props) {
  const { connected } = useClientConnection();
  const connection = useSyncExternalStore(subscribeServerConnection, getServerConnection);
  const callback = useRef(onServiceConnected);
  callback.current = onServiceConnected;
  const previous = useRef<ServiceAuthStatus | null>(null);
  const [status, setStatus] = useState<ServiceAuthStatus | null>(null);
  const [busy, setBusy] = useState<StreamingProvider | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    pending.current?.abort(); pending.current = null;
    previous.current = null; setStatus(null); setBusy(null); setError(null); setMessage(null);
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
    return () => { disposed = true; clearInterval(timer); pending.current?.abort(); };
  }, [active, connected, connection]);
  const cancel = () => {
    pending.current?.abort(); pending.current = null;
    setBusy(null); setMessage("Sign-in cancelled.");
  };
  const signIn = async (provider: StreamingProvider) => {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(provider); setError(null); setMessage(null);
    try {
      await signInService(provider, controller.signal);
      if (pending.current !== controller || controller.signal.aborted) return;
      const next = { tidal: false, qobuz: false, spotify: false, ...previous.current, [provider]: true };
      previous.current = next; setStatus(next); updateServiceAvailability(next); callback.current();
      setMessage(`${provider === "tidal" ? "Tidal" : provider === "qobuz" ? "Qobuz" : "Spotify"} connected.`);
    } catch (reason) {
      if (pending.current === controller && !controller.signal.aborted) setError(String(reason));
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(null); }
    }
  };
  return <>
    <header className="settingsPageHeader"><h1 className="settingsTitle">Services</h1></header>
    <p className="settingsMuted">Sign in through the service’s browser window. Credentials stay on your server.</p>
    {!connected && <p className="settingsMuted">Connect through Settings → Server to use streaming services.</p>}
    {(["tidal", "qobuz", "spotify"] as const).map(provider => <div className="settingsGroup" key={provider}>
      <h2>{provider === "tidal" ? "Tidal" : provider === "qobuz" ? "Qobuz" : "Spotify"}</h2>
      <p role="status">{connected && status?.[provider] ? "Connected on server" : "Unavailable"}</p>
      <button type="button" className={`settingsPill${status?.[provider] ? " settingsPillDone" : " settingsPillPrimary"}`}
        disabled={!connected || !isTauri() || busy !== null || status?.[provider] === true}
        onClick={() => void signIn(provider)} aria-label={`Sign in to ${provider === "tidal" ? "Tidal" : provider === "qobuz" ? "Qobuz" : "Spotify"}`}>
        {status?.[provider] ? "Connected" : busy === provider ? "Waiting for sign-in…" : "Sign in"}
      </button>
    </div>)}
    {busy && <p role="status" className="settingsMuted">Finish signing in in the browser window. <button type="button" className="settingsPill" onClick={cancel}>Cancel</button></p>}
    {message && <p className="settingsServiceMessage" role="status">{message}</p>}
    {error && <p className="settingsError" role="alert">{error}</p>}
    <SpotifyPlaybackSettings active={active && connected} connected={connected} />
  </>;
}
