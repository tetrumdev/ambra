import { useEffect, useState } from "react";
import { canManageSpotifyPlayback, saveSpotifyPlayback, soloistAction, spotifyPlaybackSettings, spotifyPlaybackStatus, type SoloistQuality, type SoloistStatus, type SpotifyPlaybackBackend } from "../api/spotifyPlayback";

type Props = { active: boolean; connected: boolean };

export function SpotifyPlaybackSettings({ active, connected }: Props) {
  const [status, setStatus] = useState<SoloistStatus | null>(null);
  const [backend, setBackend] = useState<SpotifyPlaybackBackend>("librespot");
  const [quality, setQuality] = useState<SoloistQuality>("lossless");
  const [fallback, setFallback] = useState<SoloistStatus["fallback"]>("never");
  const [checks, setChecks] = useState(true);
  const [executable, setExecutable] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const local = canManageSpotifyPlayback();

  useEffect(() => {
    if (!active) { setKey(""); return; }
    let disposed = false;
    const initialize = async () => {
      try {
        const settings = local ? await spotifyPlaybackSettings() : { status: await spotifyPlaybackStatus(), executable: null };
        if (disposed) return;
        setStatus(settings.status); setBackend(settings.status.backend); setQuality(settings.status.requestedQuality);
        setFallback(settings.status.fallback); setChecks(settings.status.updateChecks); setExecutable(settings.executable ?? "");
        setError(null);
      } catch (reason) { if (!disposed) setError(String(reason)); }
    };
    void initialize();
    const timer = window.setInterval(() => {
      void spotifyPlaybackStatus().then(value => { if (!disposed) setStatus(value); }).catch(() => {});
    }, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [active, local, connected]);

  async function perform(action: () => Promise<SoloistStatus>, success: string) {
    setBusy(true); setError(null); setMessage(null);
    try { setStatus(await action()); setKey(""); setMessage(success); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  return <section className="settingsCallbackForm" aria-label="Spotify playback backend">
    <h3>Spotify playback</h3>
    {!status && <p className="settingsMuted">Playback settings require an updated Ambra server.</p>}
    {status && <>
      <label htmlFor="spotify-playback-backend">Server playback backend</label>
      <select id="spotify-playback-backend" value={backend} disabled={!local || busy} onChange={event => setBackend(event.target.value as SpotifyPlaybackBackend)}>
        <option value="librespot">Librespot (default)</option>
        <option value="soloist">Soloist (experimental lossless playback)</option>
      </select>
      {!local && <p className="settingsMuted">Configure Soloist on the server machine. Paired remote clients can inspect status but cannot change its API key.</p>}
      {(backend === "soloist" || status.backend === "soloist") && <>
        <p className="settingsMuted">Soloist runs on your Ambra server. Librespot still handles Spotify sign-in, catalog, library, and playlists.</p>
        <p><a href="https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates" target="_blank" rel="noreferrer">Official installation instructions</a>{" · "}<a href="https://developer.spotify.com/dashboard/soloist" target="_blank" rel="noreferrer">Generate a personal API key</a></p>
        <p role="status">Soloist: {status.state.replace(/_/g, " ")}. {status.paired ? "Pairing saved." : "Pairing required."} {status.apiKeyPresent ? "API key saved." : "API key required."}</p>
        {status.build && <p className="settingsMuted">Version {status.build.version}. Expires {new Date(status.build.expiresAt * 1000).toLocaleDateString()}.{status.needsRefresh ? " Download a fresh build before expiration." : ""}</p>}
        <p className="settingsMuted">{status.capture.reason}</p>
        {!status.forwardingEnabled && <p className="settingsMuted">Spotify audio forwarding is disabled in this build or server environment. Release builds cannot enable it. Local development requires explicit build and runtime opt-in.</p>}
        <p className="settingsMuted">Requested quality: {status.requestedQuality.replace(/_/g, " ")}. Capture: S32LE, 44.1 kHz, stereo. Original Spotify codec and bit depth remain unverified.</p>
        {status.accountMatches === false && <p className="settingsError" role="alert">Soloist account does not match Ambra’s Spotify account. Reset pairing and select the same account.</p>}
        {status.error && <p className="settingsError" role="alert">{status.error.message}</p>}
        {local && <>
          <label htmlFor="soloist-executable">Soloist executable on the server (absolute path, or empty for PATH)</label>
          <input id="soloist-executable" value={executable} disabled={busy} onChange={event => setExecutable(event.target.value)} spellCheck={false} autoComplete="off" />
          <label htmlFor="soloist-api-key">Personal Soloist API key {status.apiKeyPresent ? "(leave empty to keep saved key)" : ""}</label>
          <input id="soloist-api-key" type="password" value={key} disabled={busy || !connected} onChange={event => setKey(event.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="off" />
          <label htmlFor="soloist-quality">Requested quality ceiling</label>
          <select id="soloist-quality" value={quality} disabled={busy} onChange={event => setQuality(event.target.value as SoloistQuality)}>
            <option value="lossless">Lossless (highest available)</option><option value="very_high">Very high</option><option value="high">High</option><option value="normal">Normal</option>
          </select>
          <label htmlFor="soloist-fallback">When Soloist is unavailable before playback</label>
          <select id="soloist-fallback" value={fallback} disabled={busy} onChange={event => setFallback(event.target.value as SoloistStatus["fallback"])}>
            <option value="never">Report the error</option><option value="librespot_before_start">Use librespot before starting the track</option>
          </select>
          <label><input type="checkbox" checked={checks} disabled={busy} onChange={event => setChecks(event.target.checked)} /> Check installed build expiration daily</label>
          <p className="settingsMuted">Automatic downloads are unavailable. Download builds from Spotify yourself. Pause playback before installing a refresh; saved pairing stays intact.</p>
          <div className="soloistActions">
            <button className="settingsPill" type="button" disabled={busy || !executable.trim()} onClick={() => void perform(async () => {
              const next = await soloistAction("install", executable.trim());
              setExecutable((await spotifyPlaybackSettings()).executable ?? "");
              return next;
            }, "Validated executable installed. Pairing preserved.")}>Install / refresh binary</button>
            <button className="settingsPill" type="button" disabled={busy} onClick={() => void perform(() => soloistAction("check"), "Installed build checked.")}>Check build</button>
            <button className="settingsPill" type="button" disabled={busy || !connected || !status.apiKeyPresent} onClick={() => void perform(() => soloistAction("pair"), "Open the official Spotify app on the same network. Select Ambra Soloist Pairing using the account connected to Ambra.")}>Pair through Spotify</button>
            <button className="settingsPill" type="button" disabled={busy} onClick={() => void perform(() => soloistAction("reset"), "Soloist pairing reset. Your Spotify library is unchanged.")}>Reset pairing</button>
            <button className="settingsPill" type="button" disabled={busy} onClick={() => void perform(async () => { const next = await soloistAction("sign-out"); setBackend(next.backend); return next; }, "Soloist key and pairing removed. Librespot selected.")}>Sign out Soloist</button>
          </div>
        </>}
      </>}
      {local && <button className="settingsPill settingsPillPrimary" type="button" disabled={busy} onClick={() => void perform(() => saveSpotifyPlayback({ backend, executable: executable.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}), quality, updateChecks: checks, fallback }), "Spotify playback settings saved on the server.")}>{busy ? "Saving…" : "Save playback settings"}</button>}
    </>}
    {message && <p className="settingsServiceMessage" role="status">{message}</p>}
    {error && <p className="settingsError" role="alert">{error}</p>}
  </section>;
}
