import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { StreamingProvider } from "../api/server";
import { getServerConnection, subscribeServerConnection } from "../api/serverConnection";
import { signInService } from "../utils/serviceSignIn";
import { markServiceConnected, useServiceStatus } from "../hooks/useServiceAvailability";
import { useClientConnection } from "../hooks/ClientConnectionContext";
import { SpotifyPlaybackSettings } from "./SpotifyPlaybackSettings";
import { SettingRow, Toggle } from "./settings/SettingsControls";

type Props = {
  active: boolean;
  onServiceConnected: () => void;
  /** Whether each service's playlists show in the library. */
  playlistVisibility: Record<StreamingProvider, boolean>;
  onPlaylistVisibilityChange: (provider: StreamingProvider, visible: boolean) => void;
};
/** Browser sign-in runs on this computer; provider credentials remain on the independent server. */
export function ServiceSettings({ active, onServiceConnected, playlistVisibility, onPlaylistVisibilityChange }: Props) {
  const { connected } = useClientConnection();
  const connection = useSyncExternalStore(subscribeServerConnection, getServerConnection);
  const callback = useRef(onServiceConnected);
  callback.current = onServiceConnected;
  const status = useServiceStatus(active && connected);
  const [busy, setBusy] = useState<StreamingProvider | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualSubmit, setManualSubmit] = useState<((url: string) => Promise<void>) | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    pending.current?.abort(); pending.current = null;
    setBusy(null); setError(null); setMessage(null); setManualSubmit(null); setCallbackUrl(""); setSubmitting(false);
    return () => { pending.current?.abort(); };
  }, [active, connected, connection]);
  const cancel = () => {
    pending.current?.abort(); pending.current = null;
    setBusy(null); setManualSubmit(null); setCallbackUrl(""); setSubmitting(false); setMessage("Sign-in cancelled.");
  };
  const signIn = async (provider: StreamingProvider) => {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(provider); setError(null); setMessage(null); setCallbackUrl(""); setSubmitting(false);
    try {
      await signInService(provider, controller.signal, submit => {
        if (pending.current === controller) setManualSubmit(() => submit);
      });
      if (pending.current !== controller || controller.signal.aborted) return;
      markServiceConnected(provider); callback.current();
      setMessage(`${provider === "tidal" ? "Tidal" : provider === "qobuz" ? "Qobuz" : "Spotify"} connected.`);
    } catch (reason) {
      if (pending.current === controller && !controller.signal.aborted) setError(String(reason));
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(null); }
    }
  };
  return <>
    <header className="settingsPageHeader"><h1 className="settingsTitle">Services</h1></header>
    {!connected && <p className="settingsMuted">Connect through Settings → Server to use streaming services.</p>}
    {(["tidal", "qobuz", "spotify"] as const).map(provider => <div className="settingsGroup" key={provider}>
      <h2>{provider === "tidal" ? "Tidal" : provider === "qobuz" ? "Qobuz" : "Spotify"}</h2>
      <p role="status">{connected && status?.[provider] ? "Connected on server" : "Unavailable"}</p>
      <button type="button" className={`uiButton${status?.[provider] ? " settingsPillDone" : " uiButtonPrimary"}`}
        disabled={!connected || !isTauri() || busy !== null || status?.[provider] === true}
        onClick={() => void signIn(provider)} aria-label={`Sign in to ${provider === "tidal" ? "Tidal" : provider === "qobuz" ? "Qobuz" : "Spotify"}`}>
        {status?.[provider] ? "Connected" : busy === provider ? "Waiting for sign-in…" : "Sign in"}
      </button>
      <SettingRow label="Show playlists">
        <Toggle label={`Show ${provider === "tidal" ? "Tidal" : provider === "qobuz" ? "Qobuz" : "Spotify"} playlists`}
          checked={playlistVisibility[provider]} onChange={visible => onPlaylistVisibilityChange(provider, visible)} />
      </SettingRow>
    </div>)}
    {busy && <p role="status" className="settingsMuted">Finish signing in in your browser. <button type="button" className="uiButton" onClick={cancel}>Cancel</button></p>}
    {busy === "tidal" && manualSubmit && <form className="settingsCallbackForm" onSubmit={event => {
      event.preventDefault();
      if (submitting || !callbackUrl.trim()) return;
      const controller = pending.current;
      setSubmitting(true); setError(null);
      void manualSubmit(callbackUrl).then(() => {
        if (pending.current === controller) setCallbackUrl("");
      }).catch(reason => {
        if (pending.current === controller) setError(String(reason));
      }).finally(() => { if (pending.current === controller) setSubmitting(false); });
    }}>
      <p className="settingsMuted">After signing in to Tidal, copy the final URL from your browser’s address bar and paste it here.</p>
      <input className="uiField" type="text" aria-label="Tidal callback URL" placeholder="https://tidal.com/android/login/auth?code=…"
        value={callbackUrl} onChange={event => setCallbackUrl(event.currentTarget.value)} autoComplete="off" spellCheck={false} />
      <button type="submit" className="uiButton uiButtonPrimary" disabled={submitting || !callbackUrl.trim()}>Finish sign-in</button>
    </form>}
    {message && <p className="settingsServiceMessage" role="status">{message}</p>}
    {error && <p className="settingsError" role="alert">{error}</p>}
    <SpotifyPlaybackSettings active={active && connected} connected={connected} />
  </>;
}
