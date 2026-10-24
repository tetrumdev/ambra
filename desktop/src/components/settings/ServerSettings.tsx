import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { serverBaseUrl, serverConnection } from "../../api/serverConnection";
import { SettingRow, Toggle } from "./SettingsControls";

type Discovered = { id: string; name: string; version: string; address: string };
type Pairing = { pending: { code: string; clientName: string; address: string; ageSeconds: number }[]; paired: { id: string; name: string; pairedAtMs: number }[] };
type LocalConfig = { id: string; name: string; bind: string; listening: string | null; discovery: boolean };
type PairingStarted = { requestId: string; code: string; address: string; serverName: string };

const sharedWithNetwork = (address: string | null) => Boolean(address) && !/^(127\.|localhost|\[::1\])/.test(address!);
const spacedCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

async function local<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${serverBaseUrl}/api/local/${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(value?.error ?? `The server answered ${response.status}`);
  return value as T;
}

/** The server's own ID, so this machine never offers to join itself. */
async function ownServerId() {
  try {
    const response = await fetch(`${serverBaseUrl}/api/server/info`, { signal: AbortSignal.timeout(2000) });
    return ((await response.json()) as { id?: string }).id ?? null;
  } catch { return null; }
}

/** Replaces this machine's library, playlists and settings with the server's, then restarts into it. */
async function adoptServer() {
  await invoke("clear_local_state");
  localStorage.clear();
  await invoke("restart_app");
}

/**
 * Pairs with a server: asks it, shows the code to approve there, and waits. Joining wipes
 * this machine's own library and settings, so it is confirmed first.
 */
function JoinFlow({ server, onCancel }: { server: { name: string; address: string }; onCancel: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [pairing, setPairing] = useState<PairingStarted | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmed) return;
    let disposed = false;
    void invoke<PairingStarted>("start_pairing", { address: server.address })
      .then(started => { if (!disposed) setPairing(started); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [confirmed, server.address]);

  useEffect(() => {
    if (!pairing) return;
    let disposed = false;
    const poll = async () => {
      try {
        const status = await invoke<string>("poll_pairing", { address: pairing.address, requestId: pairing.requestId });
        if (disposed) return;
        if (status === "approved") await adoptServer();
        else if (status === "denied") setError(`${pairing.serverName} refused this device.`);
        else if (status === "expired") setError("The pairing request expired. Try again.");
        else timer = setTimeout(poll, 1500);
      } catch (reason) {
        if (!disposed) setError(String(reason));
      }
    };
    let timer = setTimeout(poll, 1500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [pairing]);

  if (!confirmed) return <div className="serverJoin" role="group" aria-label={`Join ${server.name}`}>
    <p><strong>Join {server.name}?</strong> This computer's library, playlists, history and settings will be replaced by {server.name}'s,
      and stay in sync with it from then on. Local music files and this computer's audio devices are kept.</p>
    <div className="serverJoinActions">
      <button type="button" className="settingsPill settingsPillPrimary" onClick={() => setConfirmed(true)}>Join and replace</button>
      <button type="button" className="settingsLink" onClick={onCancel}>Cancel</button>
    </div>
  </div>;

  return <div className="serverJoin" role="status">
    {error ? <p className="settingsError">{error}</p> : pairing ? <>
      <p>Approve this device on <strong>{pairing.serverName}</strong>: open Ambra there and go to Settings → Server, or run</p>
      <code className="serverJoinCommand">ambra-server pair approve {pairing.code}</code>
      <p className="serverJoinCode" aria-label={`Code ${pairing.code}`}>{spacedCode(pairing.code)}</p>
      <p className="settingsMuted">Waiting for approval…</p>
    </> : <p className="settingsMuted">Asking {server.name}…</p>}
    <div className="serverJoinActions"><button type="button" className="settingsLink" onClick={onCancel}>{error ? "Close" : "Cancel"}</button></div>
  </div>;
}

function FindServers({ ownId }: { ownId: string | null }) {
  const [servers, setServers] = useState<Discovered[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [address, setAddress] = useState("");
  const [joining, setJoining] = useState<{ name: string; address: string } | null>(null);
  const search = useCallback(async () => {
    setSearching(true);
    try { setServers((await invoke<Discovered[]>("discover_servers", { timeoutMs: 1500 })).filter(server => server.id !== ownId)); }
    catch { setServers([]); }
    finally { setSearching(false); }
  }, [ownId]);
  useEffect(() => { void search(); }, [search]);

  if (joining) return <JoinFlow server={joining} onCancel={() => setJoining(null)} />;
  return <>
    {servers?.map(server => <SettingRow key={server.id} label={server.name} hint={`${server.address} · version ${server.version}`}>
      <button type="button" className="settingsPill" onClick={() => setJoining(server)}>Join</button>
    </SettingRow>)}
    {servers?.length === 0 && <p className="settingsMuted">No other Ambra servers answered on this network.</p>}
    <SettingRow label="Server address" hint="If it isn't found, type its IP address">
      <span className="settingsFieldRow">
        <input className="serverAddressInput" aria-label="Server address" placeholder="192.168.1.20" value={address}
          onChange={event => setAddress(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === "Enter" && address.trim()) setJoining({ name: address.trim(), address: address.trim() }); }} />
        <button type="button" className="settingsPill" disabled={!address.trim()} onClick={() => setJoining({ name: address.trim(), address: address.trim() })}>Join</button>
      </span>
    </SettingRow>
    <div className="serverJoinActions"><button type="button" className="settingsLink" disabled={searching} onClick={() => void search()}>{searching ? "Searching…" : "Search again"}</button></div>
  </>;
}

/** The server running on this computer: sharing, pairing requests and paired devices. */
function HostSettings({ active }: { active: boolean }) {
  const [config, setConfig] = useState<LocalConfig | null>(null);
  const [pairing, setPairing] = useState<Pairing>({ pending: [], paired: [] });
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextPairing] = await Promise.all([local<LocalConfig>("config"), local<Pairing>("pairing")]);
      setConfig(nextConfig);
      setPairing(nextPairing);
      setError(null);
    } catch (reason) { setError(`Couldn't reach this computer's server. ${String(reason)}`); }
  }, []);
  // Requests appear within a couple of seconds while the tab is open.
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const act = async (path: string, body: unknown) => {
    try { await local(path, body); await refresh(); }
    catch (reason) { setError(String(reason)); }
  };
  const shared = sharedWithNetwork(config?.bind ?? null);
  const restartNeeded = config !== null && config.listening !== null && config.bind !== config.listening;

  return <>
    {error && <p className="settingsError" role="alert">{error}</p>}
    <div className="settingsGroup">
      <h2>This computer</h2>
      <SettingRow label="Name" hint="What other devices see">
        <input className="serverNameInput" aria-label="Server name" key={config?.name} defaultValue={config?.name ?? ""} maxLength={64} disabled={!config}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
          onBlur={event => { const name = event.currentTarget.value.trim(); if (config && name && name !== config.name) void act("config", { name }); }} />
      </SettingRow>
      <SettingRow label="Share with your network" hint={shared ? "Paired devices can use your library, accounts and outputs" : "Only this computer can use the server"}>
        <Toggle label="Share with your network" checked={shared} disabled={!config} onChange={on => void act("config", { bind: on ? "lan" : "local" })} />
      </SettingRow>
      {restartNeeded && <p className="settingsMuted">The server listens on {config!.listening} until you stop and start it again.</p>}
      <SettingRow label="Background server" hint="Keeps running in the system tray after you close Ambra">
        <button type="button" className="settingsPill" onClick={() => void (async () => { try { await local("stop", {}); await new Promise(resolve => setTimeout(resolve, 500)); window.location.reload(); } catch (reason) { setError(String(reason)); } })()}>Stop server</button>
      </SettingRow>
    </div>
    <div className="settingsGroup">
      <h2>Devices</h2>
      {pairing.pending.map(request => <SettingRow key={request.code} label={`${request.clientName} wants to join`} hint={`Code ${spacedCode(request.code)} · ${request.address}`}>
        <span className="settingsFieldRow">
          <button type="button" className="settingsPill settingsPillPrimary" onClick={() => void act("pairing/approve", { code: request.code })}>Approve</button>
          <button type="button" className="settingsLink" onClick={() => void act("pairing/deny", { code: request.code })}>Deny</button>
        </span>
      </SettingRow>)}
      {pairing.paired.map(device => <SettingRow key={device.id} label={device.name} hint={`Paired ${new Date(device.pairedAtMs).toLocaleDateString()}`}>
        <button type="button" className="settingsLink" onClick={() => void act("pairing/revoke", { client: device.id })}>Remove</button>
      </SettingRow>)}
      {!pairing.pending.length && !pairing.paired.length && <p className="settingsMuted">
        {shared ? "No other devices yet. Open Ambra on another computer on this network and join this one." : "Share with your network to let other devices join."}
      </p>}
    </div>
    <div className="settingsGroup">
      <h2>Use another server</h2>
      {joining ? <FindServers ownId={config?.id ?? null} /> : <SettingRow label="Join a server on your network" hint="This computer then uses that server's library and settings">
        <button type="button" className="settingsPill" onClick={() => setJoining(true)}>Find servers</button>
      </SettingRow>}
    </div>
  </>;
}

function JoinedSettings() {
  const connection = serverConnection!;
  const server = connection.server!;
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (connection.fallback) return;
    let disposed = false;
    const check = async () => {
      try {
        const response = await fetch(`${serverBaseUrl}/api/server/info`, { signal: AbortSignal.timeout(3000) });
        if (!disposed) setReachable(response.ok);
      } catch { if (!disposed) setReachable(false); }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [connection.fallback]);

  const leave = async () => {
    try {
      await invoke("leave_server");
      await adoptServer();
    } catch (reason) { setError(String(reason)); }
  };

  return <>
    {error && <p className="settingsError" role="alert">{error}</p>}
    <div className="settingsGroup">
      <h2>Server</h2>
      <SettingRow label={server.name} hint={server.address}>
        <span className="settingsChip" data-state={connection.fallback ? "away" : reachable === false ? "away" : "connected"}>
          {connection.fallback ? "Not in use" : reachable === null ? "Checking…" : reachable ? "Connected" : "Unavailable"}
        </span>
      </SettingRow>
      <p className="settingsMuted">Ambra remembers this server and waits for it when unavailable. You can also start a local server from the connection screen.</p>
    </div>
    <div className="settingsGroup">
      <h2>Leave</h2>
      {leaving ? <div className="serverJoin" role="group" aria-label="Leave server">
        <p>This computer will look for a separately running local server or let you choose another server. {server.name} keeps everything.</p>
        <div className="serverJoinActions">
          <button type="button" className="settingsPill" onClick={() => void leave()}>Leave and restart</button>
          <button type="button" className="settingsLink" onClick={() => setLeaving(false)}>Cancel</button>
        </div>
      </div> : <SettingRow label={`Stop using ${server.name}`} hint="Choose another server">
        <button type="button" className="settingsPill" onClick={() => setLeaving(true)}>Leave server</button>
      </SettingRow>}
    </div>
  </>;
}

export function ServerSettings({ active }: { active: boolean }) {
  const connection = serverConnection;
  return <>
    <header className="settingsPageHeader"><h1 className="settingsTitle">Server</h1></header>
    {!connection ? <p className="settingsMuted">Sharing a server between devices needs the desktop app.</p>
      : connection.mode === "join" && connection.server ? <JoinedSettings />
      : <HostSettings active={active} />}
  </>;
}

/** Available before server state loads, so a new device can find and pair with a server. */
export function ServerSetup({ loading, onReconnect }: { loading: boolean; onReconnect: () => void }) {
  const server = serverConnection?.server;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setStarting(true); setError(null);
    try {
      await invoke("start_local_server");
      if (serverConnection?.mode === "join") await invoke("leave_server");
      await invoke("restart_app");
    } catch (reason) { setError(String(reason)); setStarting(false); }
  };
  return <section className="settingsView" style={{ maxWidth: 680, width: "100%", margin: "0 auto", overflowY: "auto", padding: 32 }}>
    <header className="settingsPageHeader"><h1 className="settingsTitle">Connect to your music server</h1></header>
    <p className="settingsMuted">{server ? `Waiting for ${server.name} at ${server.address}.` : "Start a server on this computer, or join one already running on your network."}</p>
    <div className="settingsGroup">
      <h2>Start a server</h2>
      <p className="settingsMuted">Run the server on this computer in the background. Its tray icon lets you stop it; the app window and terminal can be closed.</p>
      {isTauri() && <button type="button" className="settingsPill settingsPillPrimary" disabled={starting} onClick={() => void start()}>{starting ? "Starting…" : "Start server on this computer"}</button>}
      <p className="settingsMuted">Or start it from any terminal:</p>
      <code className="serverJoinCommand">ambra-server start</code>
      {error && <p className="settingsError" role="alert">{error}</p>}
      <button type="button" className="settingsPill" disabled={loading} onClick={onReconnect}>{loading ? "Connecting…" : "Reconnect"}</button>
    </div>
    {serverConnection && <div className="settingsGroup"><h2>Servers on your network</h2><FindServers ownId={null} /></div>}
  </section>;
}

/** On first launch, offers to join a server already running elsewhere on the network. */
export function ServerOffer() {
  const [found, setFound] = useState<Discovered | null>(null);
  const [joining, setJoining] = useState(false);
  useEffect(() => {
    const connection = serverConnection;
    if (!connection || connection.mode !== "host" || connection.decided) return;
    let disposed = false;
    void (async () => {
      const [ownId, servers] = await Promise.all([ownServerId(), invoke<Discovered[]>("discover_servers", { timeoutMs: 2000 }).catch(() => [])]);
      const other = servers.find(server => server.id !== ownId);
      if (disposed) return;
      if (other) setFound(other);
      else void invoke("set_server_link_decided").catch(() => {});
    })();
    return () => { disposed = true; };
  }, []);
  if (!found) return null;
  const dismiss = () => { setFound(null); void invoke("set_server_link_decided").catch(() => {}); };
  return <div className="serverOffer" role="dialog" aria-label="Join a server on your network">
    {joining ? <JoinFlow server={found} onCancel={dismiss} /> : <>
      <p><strong>{found.name}</strong> is running Ambra on your network. Join it to share its library, playlists, accounts and outputs?</p>
      <div className="serverJoinActions">
        <button type="button" className="settingsPill settingsPillPrimary" onClick={() => setJoining(true)}>Join…</button>
        <button type="button" className="settingsLink" onClick={dismiss}>Use the local server</button>
      </div>
    </>}
  </div>;
}
