import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connectToServer, getServerConnection, subscribeServerConnection } from "../../api/serverConnection";
import { useClientConnection } from "../../hooks/ClientConnectionContext";
import { flushPersistentState } from "../../utils/persistentStorage";
import { flushServerState, withServerStateTransition } from "../../utils/serverState";
import { SettingRow, Toggle } from "./SettingsControls";

type Discovered = { id: string; name: string; version: string; address: string };
type PairingStarted = { requestId: string; code: string; address: string; serverName: string };

/** Save both owners before changing the optional server; leave the local player mounted. */
async function applyConnection(command: "join_server" | "leave_server", setSharedPlayback: (shared: boolean, remember?: boolean) => Promise<void>, args?: Record<string, unknown>) {
  window.dispatchEvent(new Event("ambra:save-session"));
  await flushPersistentState();
  await withServerStateTransition(async () => {
    await invoke(command, args);
    await setSharedPlayback(false, false);
    await connectToServer();
  });
}

function JoinFlow({ server, onCancel, onConnected }: { server: { name: string; address: string }; onCancel: () => void; onConnected: () => void }) {
  const { setSharedPlayback } = useClientConnection();
  const completed = useRef(onConnected);
  completed.current = onConnected;
  const [pairing, setPairing] = useState<PairingStarted | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const started = invoke<PairingStarted>("start_pairing", { address: server.address });
    void started.then(value => { if (!disposed) setPairing(value); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => {
      disposed = true;
      void started.then(value => invoke("cancel_pairing", { requestId: value.requestId })).catch(() => {});
    };
  }, [server.address]);
  useEffect(() => {
    if (!pairing) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await invoke<string>("poll_pairing", { address: pairing.address, requestId: pairing.requestId });
        if (disposed) return;
        if (status === "approved") {
          await applyConnection("join_server", setSharedPlayback, { requestId: pairing.requestId });
          completed.current();
        }
        else if (status === "denied") setError(`${pairing.serverName} refused this device.`);
        else if (status === "expired") setError("The pairing request expired. Try again.");
        else timer = setTimeout(poll, 1500);
      } catch (reason) { if (!disposed) setError(String(reason)); }
    };
    timer = setTimeout(poll, 1500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [pairing, setSharedPlayback]);
  return <div className="serverJoin" role="status">
    {error ? <p className="settingsError">{error}</p> : pairing ? <>
      <p>Approve this device on <strong>{pairing.serverName}</strong> using its server CLI:</p>
      <code className="serverJoinCommand">ambra-server pair approve {pairing.code}</code>
      <p className="serverJoinCode" aria-label={`Code ${pairing.code}`}>{pairing.code.slice(0, 3)} {pairing.code.slice(3)}</p>
      <p className="settingsMuted">Waiting for approval. Your local library and playlists stay on this device.</p>
    </> : <p className="settingsMuted">Asking {server.name}…</p>}
    <button type="button" className="settingsLink" onClick={onCancel}>{error ? "Close" : "Cancel"}</button>
  </div>;
}

function FindServers({ onConnected }: { onConnected: () => void }) {
  const [servers, setServers] = useState<Discovered[]>([]);
  const [searching, setSearching] = useState(false);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState<{ name: string; address: string } | null>(null);
  const search = useCallback(async () => {
    setSearching(true);
    try { setServers(await invoke<Discovered[]>("discover_servers", { timeoutMs: 1500 })); }
    catch (reason) { setError(String(reason)); }
    finally { setSearching(false); }
  }, []);
  useEffect(() => { void search(); }, [search]);
  const join = () => { if (address.trim()) setJoining({ name: address.trim(), address: address.trim() }); };
  if (joining) return <JoinFlow key={joining.address} server={joining} onCancel={() => setJoining(null)} onConnected={onConnected} />;
  return <>
    {servers.map(server => <SettingRow key={server.id} label={server.name} hint={`${server.address} · version ${server.version}`}>
      <button type="button" className="settingsPill" onClick={() => setJoining(server)}>Connect</button>
    </SettingRow>)}
    {!servers.length && !searching && <p className="settingsMuted">No Ambra servers answered on this network.</p>}
    <SettingRow label="Server address or pairing link" hint="Enter an IP address, hostname, or ambra://pair/ link from the server QR code.">
      <span className="settingsFieldRow">
        <input className="serverAddressInput" aria-label="Server address or pairing link" placeholder="ambra://pair/… or music.local" value={address}
          onChange={event => setAddress(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Enter") join(); }} />
        <button type="button" className="settingsPill" disabled={!address.trim()} onClick={join}>Connect</button>
      </span>
    </SettingRow>
    <SettingRow label="Import pairing link" hint="Import a text file containing the server-generated pairing link.">
      <input aria-label="Import pairing link" type="file" accept="text/plain,.txt" onChange={event => {
        const file = event.currentTarget.files?.[0];
        if (file) void file.text().then(text => {
          if (!text.trim().startsWith("ambra://pair/")) throw new Error("Choose a file containing an Ambra pairing link.");
          setAddress(text.trim());
        }).catch(reason => setError(String(reason)));
      }} />
    </SettingRow>
    {error && <p className="settingsError" role="alert">{error}</p>}
    <button type="button" className="settingsLink" disabled={searching} onClick={() => void search()}>{searching ? "Searching…" : "Search again"}</button>
  </>;
}

/** Optional connection screen. Local playback remains mounted behind this settings panel. */
export function ServerSetup({ onBack }: { onBack: () => void }) {
  return <div className="serverSetup">
    <h2>Connect to Ambra Server</h2>
    <p className="settingsMuted">Connect to an independently running server for streaming, shared libraries, and shared playback. Local music works without one.</p>
    <FindServers onConnected={onBack} />
    <button type="button" className="settingsLink" onClick={onBack}>Back to local player settings</button>
  </div>;
}

export function ServerSettings({ active }: { active: boolean }) {
  const { connected, network, sharedPlayback, setSharedPlayback, reconnect } = useClientConnection();
  const [setup, setSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = useSyncExternalStore(subscribeServerConnection, getServerConnection);
  const server = connection?.server;
  const [changing, setChanging] = useState(false);
  const connectionType = !server ? "Local" : !connected ? "Offline"
    : network.method === "Lan" ? "Local network"
    : network.method === "Pwnat" ? "pwnat"
    : network.method === "HyperDHT" ? "HyperDHT" : "Unknown";
  const disconnect = async () => {
    if (changing) return;
    setChanging(true);
    setError(null);
    try { await applyConnection("leave_server", setSharedPlayback); }
    catch (reason) { setError(String(reason)); }
    finally { setChanging(false); }
  };
  return <>
    <header className="settingsPageHeader"><h1 className="settingsTitle">Server</h1></header>
    {error && <p className="settingsError" role="alert">{error}</p>}
    {setup && active ? <ServerSetup onBack={() => setSetup(false)} /> : <div className="settingsGroup">
      <SettingRow label="Connection type">
        <input type="text" aria-label="Connection type" value={connectionType} readOnly />
      </SettingRow>
      {server ? <>
        <SettingRow label={server.name} hint={server.address}>
          <span className="settingsChip" data-state={connected ? "connected" : "away"}>{connected ? "Connected" : "Disconnected"}</span>
        </SettingRow>
        {network.error && <p className="settingsMuted" role="status">{network.error}</p>}
        <SettingRow label="Shared playback session" hint="Control the server queue and share this device’s output. Turn off to play your private local queue.">
          <Toggle label="Shared playback session" checked={sharedPlayback} disabled={!connected} onChange={shared => void setSharedPlayback(shared).catch(reason => setError(String(reason)))} />
        </SettingRow>
        <div className="serverJoinActions">
          <button type="button" className="settingsPill" onClick={reconnect}>Reconnect</button>
          <button type="button" className="settingsPill" disabled={changing} onClick={() => void disconnect()}>Disconnect</button>
          <button type="button" className="settingsPill" onClick={() => {
            void flushServerState().then(() => setSetup(true)).catch(reason => setError(String(reason)));
          }}>Choose another server</button>
        </div>
      </> : <>
        <p className="settingsMuted">No server connected. Local music, playlists, queues, and settings stay on this device.</p>
        <button type="button" className="settingsPill settingsPillPrimary" disabled={!isTauri()} onClick={() => setSetup(true)}>Connect to Ambra Server</button>
      </>}
    </div>}
  </>;
}
