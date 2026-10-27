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
  return <section className="settingsGroup" aria-label="Spotify playback backend">
    <h2>Spotify playback</h2>
    {connected && status && <p role="status">{status.backend}: {status.state.replace(/_/g, " ")}. Requested quality: {status.requestedQuality}.</p>}
    <p className="settingsMuted">Manage playback, Soloist installation, and pairing with <code>ambra-server spotify</code> on the server.</p>
  </section>;
}
