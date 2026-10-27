import { useEffect, useState } from "react";
import { spotifyPlaybackStatus, type SoloistStatus } from "../api/spotifyPlayback";

export function SpotifyPlaybackSettings({ active, connected }: { active: boolean; connected: boolean }) {
  const [status, setStatus] = useState<SoloistStatus | null>(null);
  useEffect(() => {
    if (!active || !connected) return;
    let disposed = false;
    const refresh = () => void spotifyPlaybackStatus().then(value => { if (!disposed) setStatus(value); }).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [active, connected]);
  return <section className="settingsGroup" aria-label="Spotify playback">
    <h2>Spotify playback</h2>
    {connected && status && <p role="status">Preferred: {status.preferredQuality ?? status.requestedQuality}. Current renderer: {status.effectiveRenderer ?? "idle"}. {status.state.replace(/_/g, " ")}.</p>}
    <p className="settingsMuted">Manage playback, Soloist installation, and pairing with <code>ambra-server spotify</code> on the server.</p>
  </section>;
}
