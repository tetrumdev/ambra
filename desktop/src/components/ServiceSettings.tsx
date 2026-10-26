import { SpotifyPlaybackSettings } from "./SpotifyPlaybackSettings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import {
  completeServiceAuth,
  disconnectService,
  serviceAuthStatus,
  startServiceAuth,
  type ServiceAuthStatus,
  type StreamingProvider,
} from "../api/server";
import { refreshServiceAvailability, updateServiceAvailability, useServiceAvailability } from "../hooks/useServiceAvailability";

type CallbackProvider = Exclude<StreamingProvider, "spotify">;
type Props = { active: boolean; onServiceConnected: () => void };

const services: Array<{ id: StreamingProvider; name: string; detail: string }> = [
  { id: "tidal", name: "Tidal", detail: "Lossless and hi-res" },
  { id: "qobuz", name: "Qobuz", detail: "Lossless and hi-res" },
  { id: "spotify", name: "Spotify", detail: "Signs in through your browser" },
];

const disconnected: ServiceAuthStatus = { tidal: false, qobuz: false, spotify: false };

export function ServiceSettings({ active, onServiceConnected }: Props) {
  const connectedServices = useServiceAvailability();
  const [status, setStatus] = useState<ServiceAuthStatus>(disconnected);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<StreamingProvider | null>(null);
  const [callbackProvider, setCallbackProvider] = useState<CallbackProvider | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<StreamingProvider | null>(null);
  useEffect(() => { if (connectedServices) setStatus(connectedServices); }, [connectedServices]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoading(true);
    setError(null);
    void serviceAuthStatus(true)
      .then(value => { if (!disposed) { setStatus(value); updateServiceAvailability(value); } })
      .catch((reason: unknown) => { if (!disposed) setError(String(reason)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [active]);

  async function signIn(provider: StreamingProvider) {
    setBusy(provider);
    setError(null);
    setMessage(null);
    try {
      const result = await startServiceAuth(provider);
      if (result.status === "connected") {
        void refreshServiceAvailability();
        setStatus(current => ({ ...current, [provider]: true }));
        setMessage(`${services.find(service => service.id === provider)?.name} connected.`);
        onServiceConnected();
      } else if (result.loginUrl && provider !== "spotify") {
        setCallbackProvider(provider);
        setCallbackUrl("");
        await openUrl(result.loginUrl);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function finishSignIn() {
    if (!callbackProvider || !callbackUrl.trim()) return;
    const provider = callbackProvider;
    setBusy(provider);
    setError(null);
    try {
      await completeServiceAuth(provider, callbackUrl.trim());
      void refreshServiceAvailability();
      setStatus(current => ({ ...current, [provider]: true }));
      setCallbackProvider(null);
      setCallbackUrl("");
      setMessage(`${services.find(service => service.id === provider)?.name} connected.`);
      onServiceConnected();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(provider: StreamingProvider) {
    setBusy(provider);
    setError(null);
    setMessage(null);
    try {
      const next = await disconnectService(provider);
      setStatus(next);
      updateServiceAvailability(next);
      setDisconnecting(null);
      if (callbackProvider === provider) { setCallbackProvider(null); setCallbackUrl(""); }
      setMessage(`${services.find(service => service.id === provider)?.name} disconnected from Ambra. Your Ambra playlists are unchanged.`);
      onServiceConnected();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(null); }
  }

  return <>
    <header className="settingsPageHeader"><h1 className="settingsTitle">Services</h1></header>
    {loading && <p className="settingsMuted" role="status">Checking connections…</p>}
    {services.map(service => <section className="settingsServiceRow" aria-label={service.name} key={service.id}>
      <img className="settingsServiceIcon" src={`/${service.id}.svg`} alt="" aria-hidden="true" />
      <div><h3>{service.name}</h3><p>{service.detail}</p></div>
      <button type="button" className={`settingsPill${status[service.id] ? " settingsPillDone" : " settingsPillPrimary"}`}
        disabled={loading || busy !== null}
        aria-label={status[service.id] ? `Disconnect ${service.name}` : `Sign in to ${service.name}`}
        onClick={() => status[service.id] ? setDisconnecting(service.id) : void signIn(service.id)}>
        {status[service.id] ? busy === service.id ? "Disconnecting…" : "Disconnect" : busy === service.id
          ? service.id === "spotify" ? "Waiting…" : "Opening…" : "Sign in"}
      </button>
    </section>)}
    <SpotifyPlaybackSettings active={active} connected={status.spotify} />
    {disconnecting && <section className="settingsCallbackForm" role="group" aria-label="Confirm disconnect">
      <p>Disconnect {services.find(service => service.id === disconnecting)?.name} from this Ambra server?</p>
      <p className="settingsMuted">Its service playlists will disappear from Ambra, not from your service account. Ambra playlists stay intact. Its tracks will be unavailable until you reconnect or replace them with Improve Playlist.</p>
      <p className="settingsMuted">This removes Ambra’s saved sign-in. To revoke access at the provider too, use that service’s account settings.</p>
      <div><button className="settingsPill" type="button" disabled={busy !== null} onClick={() => setDisconnecting(null)}>Cancel</button>
        <button className="settingsPill settingsPillPrimary" type="button" disabled={busy !== null} onClick={() => void disconnect(disconnecting)}>Disconnect</button></div>
    </section>}
    {callbackProvider && <form className="settingsCallbackForm" onSubmit={event => {
      event.preventDefault();
      void finishSignIn();
    }}>
      <label htmlFor="settings-callback-url">
        Paste the full {callbackProvider === "tidal" ? "Tidal" : "Qobuz"} callback URL
      </label>
      <p className="settingsMuted">If the page doesn't load after signing in, copy its address anyway.</p>
      <div><input id="settings-callback-url" spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
        autoFocus value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} placeholder="http://…" />
        <button type="submit" className="settingsPill settingsPillPrimary" disabled={!callbackUrl.trim() || loading || busy !== null}>Connect</button>
      </div>
    </form>}
    {message && <p className="settingsServiceMessage" role="status">{message}</p>}
    {error && <p className="settingsError" role="alert">{error}</p>}
  </>;
}
