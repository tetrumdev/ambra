import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import {
  completeServiceAuth,
  serviceAuthStatus,
  startServiceAuth,
  type ServiceAuthStatus,
  type StreamingProvider,
} from "../api/server";

type CallbackProvider = Exclude<StreamingProvider, "spotify">;
type Props = { active: boolean; onServiceConnected: () => void };

const services: Array<{ id: StreamingProvider; name: string; detail: string }> = [
  { id: "tidal", name: "Tidal", detail: "Lossless and hi-res streaming" },
  { id: "qobuz", name: "Qobuz", detail: "Lossless and hi-res streaming" },
  { id: "spotify", name: "Spotify", detail: "Connect with Spotify in your browser" },
];

const disconnected: ServiceAuthStatus = { tidal: false, qobuz: false, spotify: false };

export function ServiceSettings({ active, onServiceConnected }: Props) {
  const [status, setStatus] = useState<ServiceAuthStatus>(disconnected);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<StreamingProvider | null>(null);
  const [callbackProvider, setCallbackProvider] = useState<CallbackProvider | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoading(true);
    setError(null);
    void serviceAuthStatus()
      .then(value => { if (!disposed) setStatus(value); })
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

  return <>
    <div className="settingsSectionHeading"><div>
      <h2>Streaming services</h2>
      <p>Connect your accounts to search and play music from your services.</p>
    </div></div>
    {loading && <p role="status">Checking connections…</p>}
    {services.map(service => <section className="settingsServiceRow" aria-label={service.name} key={service.id}>
      <div><h3>{service.name}</h3><p>{service.detail}</p></div>
      <button type="button" className="settingsButton"
        disabled={loading || status[service.id] || busy !== null}
        aria-label={status[service.id] ? `${service.name} connected` : `Sign in to ${service.name}`}
        onClick={() => void signIn(service.id)}>
        {status[service.id] ? "Connected" : busy === service.id
          ? service.id === "spotify" ? "Waiting…" : "Opening…" : "Sign in"}
      </button>
    </section>)}
    {callbackProvider && <form className="settingsCallbackForm" onSubmit={event => {
      event.preventDefault();
      void finishSignIn();
    }}>
      <label htmlFor="settings-callback-url">
        Paste the full {callbackProvider === "tidal" ? "Tidal" : "Qobuz"} callback URL
      </label>
      <p>The page may fail to load after sign-in. Copy its full address from the browser.</p>
      <div><input id="settings-callback-url" spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off"
        autoFocus value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} placeholder="http://…" />
        <button type="submit" className="settingsButton" disabled={!callbackUrl.trim() || loading || busy !== null}>Connect</button>
      </div>
    </form>}
    {message && <p className="settingsServiceMessage" role="status">{message}</p>}
    {error && <p className="settingsError" role="alert">{error}</p>}
  </>;
}
