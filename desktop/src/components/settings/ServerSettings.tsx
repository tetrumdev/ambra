import { invoke, isTauri } from "@tauri-apps/api/core";
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { connectToServer, getServerConnection, subscribeServerConnection, type ConnectionMethod } from "../../api/serverConnection";
import { useClientConnection } from "../../hooks/ClientConnectionContext";
import { flushPersistentState } from "../../utils/persistentStorage";
import { flushServerState, withServerStateTransition } from "../../utils/serverState";
import { Help, SettingRow, Toggle } from "./SettingsControls";
import {
  MAIN_SESSION, coreOutputs, coreSession, coreSessions, createCoreSession, removeCoreSession, renameCoreSession, setCoreSession, subscribeCore, syncCoreSettings,
  type CoreSession,
} from "../../api/core";

type Discovered = { id: string; name: string; version: string; address: string };
type PairingStarted = { requestId: string; code: string; address: string; serverName: string };
type SavedServer = { id: string; name: string; address: string; publicKey: string | null; selected: boolean };
type ConnectionCommand = "join_server" | "leave_server" | "connect_saved_server" | "forget_saved_server" | "set_connection_method";

const connectionMethods: { value: ConnectionMethod; label: string }[] = [
  { value: "Lan", label: "Local network" },
  { value: "Public", label: "Internet (direct)" },
  { value: "HyperDHT", label: "HyperDHT" },
  { value: "TcpPunch", label: "Direct TCP (Nostr)" },
  { value: "Pwnat", label: "pwnat" },
  { value: "Tailcat", label: "Tailcat" },
];

/** Save both owners before changing the optional server; leave the local player mounted. */
async function applyConnection(command: ConnectionCommand, setSharedPlayback: (shared: boolean, remember?: boolean) => Promise<void>, args?: Record<string, unknown>) {
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
    let started: Promise<PairingStarted> | undefined;
    // Let StrictMode finish its development remount before starting native pairing.
    // Two concurrent starts share a device identity and invalidate each other.
    queueMicrotask(() => {
      if (disposed) return;
      started = invoke<PairingStarted>("start_pairing", { address: server.address });
      void started.then(value => { if (!disposed) setPairing(value); })
        .catch(reason => { if (!disposed) setError(String(reason)); });
    });
    return () => {
      disposed = true;
      void started?.then(value => invoke("cancel_pairing", { requestId: value.requestId })).catch(() => {});
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
    <SettingRow label="Server address or pairing link" help="An IP address, a hostname, or the ambra://pair/ link from the server's QR code.">
      <span className="settingsActions">
        <input className="serverAddressInput" aria-label="Server address or pairing link" placeholder="ambra://pair/… or music.local" value={address}
          onChange={event => setAddress(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Enter") join(); }} />
        <button type="button" className="settingsPill" disabled={!address.trim()} onClick={join}>Connect</button>
      </span>
    </SettingRow>
    <SettingRow label="Import pairing link" help="A text file holding the pairing link the server made.">
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
    <h2>Connect to Ambra Server<Help topic="Ambra Server">A server, running on its own, brings streaming services, a shared library and shared playback. Local music works without one.</Help></h2>
    <FindServers onConnected={onBack} />
    <button type="button" className="settingsLink" onClick={onBack}>Back to local player settings</button>
  </div>;
}

/** Servers paired earlier: connect to one without pairing again, or forget its pairing. */
function SavedServers({ saved, changing, onChange }: {
  saved: SavedServer[];
  changing: boolean;
  onChange: (command: ConnectionCommand, args: Record<string, unknown>) => void;
}) {
  const others = saved.filter(server => !server.selected);
  if (!others.length) return null;
  return <div className="settingsGroup">
    <h2>Saved servers</h2>
    {others.map(server => <SettingRow key={server.publicKey ?? server.id} label={server.name} hint={server.address}>
      <span className="settingsActions">
        <button type="button" className="settingsPill" disabled={changing || !server.publicKey}
          onClick={() => onChange("connect_saved_server", { publicKey: server.publicKey })}>Connect</button>
        <button type="button" className="settingsPill" disabled={changing || !server.publicKey}
          onClick={() => onChange("forget_saved_server", { publicKey: server.publicKey })}>Forget</button>
      </span>
    </SettingRow>)}
  </div>;
}

function describeSession(session: CoreSession, sessions: CoreSession[]) {
  const syncedWith = session.settingsFrom && sessions.find(other => other.id === session.settingsFrom)?.name;
  const track = session.track ? [session.track.title, session.track.artist].filter(Boolean).join(" · ") : "Nothing queued";
  const outputs = coreOutputs(session);
  const output = outputs.length ? `${session.playing ? "Playing" : "Paused"} on ${outputs.map(output => output.endpointName).join(", ")}` : "No output";
  return `${track} — ${output}${syncedWith ? ` — Settings synced with ${syncedWith}` : ""}`;
}

/** The server's sessions: each has its own queue and output, and this device follows one. */
function PlaybackSessions() {
  const current = useSyncExternalStore(subscribeCore, coreSession);
  const [sessions, setSessions] = useState<CoreSession[]>([]);
  const [naming, setNaming] = useState<{ id: string | null; name: string } | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => coreSessions().then(setSessions), []);
  useEffect(() => {
    void refresh().catch(reason => setError(String(reason)));
    const timer = setInterval(() => void refresh().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  // A server from before sessions answers with none.
  if (!sessions.length) return null;
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try { await work(); await refresh(); }
    catch (reason) { setError(String(reason)); }
  };
  const save = () => {
    if (!naming?.name.trim()) return;
    void act(async () => {
      if (naming.id) await renameCoreSession(naming.id, naming.name);
      else setCoreSession((await createCoreSession(naming.name)).id);
      setNaming(null);
    });
  };
  return <div className="settingsGroup">
    <h2>Sessions<Help topic="Sessions">Each session is a profile: its own queue, stages and settings, so different rooms can play different music at once. This device controls the one it follows, with that session's settings. Sync with shares another session's settings.</Help></h2>
    {sessions.map(session => <Fragment key={session.id}><SettingRow label={session.name} hint={describeSession(session, sessions)}>
      <span className="settingsActions">
        {session.id === current
          ? <span className="settingsChip" data-state="connected">Following</span>
          : <button type="button" className="settingsPill" onClick={() => setCoreSession(session.id)}>Follow</button>}
        <button type="button" className="settingsPill" onClick={() => setNaming({ id: session.id, name: session.name })}>Rename</button>
        {session.id !== MAIN_SESSION && <button type="button" className="settingsPill"
          onClick={() => void act(() => removeCoreSession(session.id))}>Remove</button>}
        {session.settingsFrom
          ? <button type="button" className="settingsPill" onClick={() => void act(() => syncCoreSettings(session.id, null))}>Stop syncing</button>
          : sessions.length > 1 && <button type="button" className="settingsPill" aria-expanded={linking === session.id}
            onClick={() => setLinking(linking === session.id ? null : session.id)}>Sync with</button>}
      </span>
    </SettingRow>
    {linking === session.id && !session.settingsFrom && <SettingRow label="Sync settings with">
      <span className="settingsActions">
        {sessions.filter(other => (other.settingsFrom ?? other.id) !== session.id && other.id !== session.id).map(other =>
          <button key={other.id} type="button" className="settingsPill"
            onClick={() => void act(async () => { await syncCoreSettings(session.id, other.id); setLinking(null); })}>{other.name}</button>)}
      </span>
    </SettingRow>}
    </Fragment>)}
    {naming ? <SettingRow label={naming.id ? "Rename session" : "New session"}>
      <span className="settingsActions">
        <input type="text" aria-label="Session name" value={naming.name} maxLength={60} autoFocus
          onChange={event => setNaming({ ...naming, name: event.target.value })}
          onKeyDown={event => { if (event.key === "Enter") save(); else if (event.key === "Escape") setNaming(null); }} />
        <button type="button" className="settingsPill" disabled={!naming.name.trim()} onClick={save}>Save</button>
        <button type="button" className="settingsLink" onClick={() => setNaming(null)}>Cancel</button>
      </span>
    </SettingRow> : <button type="button" className="settingsPill" onClick={() => setNaming({ id: null, name: "" })}>New session</button>}
    {error && <p className="settingsError" role="alert">{error}</p>}
  </div>;
}

type ServerCommand = { path: string; installed: boolean; available: boolean };

/** Downloads the server for this computer from the release matching this app; the app never ships it. */
function ServerCommandInstall() {
  const [command, setCommand] = useState<ServerCommand | null>(null);
  const [installing, setInstalling] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (isTauri()) void invoke<ServerCommand>("server_command_status").then(setCommand).catch(() => {});
  }, []);
  if (!command?.available) return null;
  const install = async () => {
    setInstalling(true);
    setError(null);
    try { setCommand(await invoke<ServerCommand>("install_server_command")); setDone(true); }
    catch (reason) { setError(String(reason)); }
    finally { setInstalling(false); }
  };
  return <div className="settingsGroup">
    <SettingRow label="Run a server on this computer"
      hint={command.installed ? `Installed at ${command.path}` : undefined}
      help="Downloads the ambra-server command for this computer and adds it to your PATH.">
      <button type="button" className="settingsPill" disabled={installing} onClick={() => void install()}>
        {installing ? "Downloading…" : command.installed ? "Update" : "Download"}
      </button>
    </SettingRow>
    {done && <p className="settingsMuted" role="status">Installed. Open a new terminal and run <code>ambra-server start</code>.</p>}
    {error && <p className="settingsError" role="alert">{error}</p>}
  </div>;
}

export function ServerSettings({ active }: { active: boolean }) {
  const { connected, network, sharedPlayback, setSharedPlayback, reconnect } = useClientConnection();
  const [setup, setSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = useSyncExternalStore(subscribeServerConnection, getServerConnection);
  const server = connection?.server;
  const [changing, setChanging] = useState(false);
  const [saved, setSaved] = useState<SavedServer[]>([]);
  useEffect(() => {
    if (!isTauri() || !active || setup) return;
    let disposed = false;
    void invoke<SavedServer[]>("saved_servers").then(list => { if (!disposed) setSaved(list); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [active, setup, connection]);
  const change = async (command: ConnectionCommand, args?: Record<string, unknown>) => {
    if (changing) return;
    setChanging(true);
    setError(null);
    try {
      await applyConnection(command, setSharedPlayback, args);
      setSaved(await invoke<SavedServer[]>("saved_servers"));
    }
    catch (reason) { setError(String(reason)); }
    finally { setChanging(false); }
  };
  const connectionType = !server ? "Local" : !connected ? "Offline"
    : network.method === "Lan" ? "Local network"
    : network.method === "TcpPunch" ? "Direct TCP (Nostr)"
    : network.method === "Pwnat" ? "pwnat"
    : network.method === "HyperDHT" ? "HyperDHT"
    : network.method === "Tailcat" ? network.tailcatPath?.kind === "direct" ? "Tailcat (direct)"
      : network.tailcatPath?.kind === "derp" ? "Tailcat (DERP relay)" : "Tailcat (path unknown)"
    : network.method === "Public" ? "Internet (direct)" : "Unknown";
  return <>
    <header className="settingsPageHeader"><h1 className="settingsTitle">Server</h1></header>
    {error && <p className="settingsError" role="alert">{error}</p>}
    {setup && active ? <ServerSetup onBack={() => setSetup(false)} /> : <>
      <div className="settingsGroup">
        <SettingRow label="Connection type" hint={`Current: ${connectionType}.`}
          help="Automatic chooses the best available connection. A manual type never falls back to another. Changing the type reconnects and turns off shared playback.">
          <select aria-label="Connection type" value={server ? connection?.connectionMethod ?? "" : ""} disabled={!server || changing || !isTauri()}
            onChange={event => void change("set_connection_method", { method: event.currentTarget.value || null })}>
            <option value="">Automatic</option>
            {connectionMethods.map(method => <option key={method.value} value={method.value}>{method.label}</option>)}
          </select>
        </SettingRow>
        {server ? <>
          <SettingRow label={server.name} hint={server.address}>
            <span className="settingsChip" data-state={connected ? "connected" : "away"}>{connected ? "Connected" : "Disconnected"}</span>
          </SettingRow>
          {network.error && <p className="settingsMuted" role="status">{network.error}</p>}
          <SettingRow label="Shared playback session" help="Controls the server's queue and shares this device's outputs with it. Turn it off to play your own local queue.">
            <Toggle label="Shared playback session" checked={sharedPlayback} disabled={!connected && !sharedPlayback} onChange={shared => void setSharedPlayback(shared).catch(reason => setError(String(reason)))} />
          </SettingRow>
          <div className="settingsActions">
            <button type="button" className="settingsPill" onClick={reconnect}>Reconnect</button>
            <button type="button" className="settingsPill" disabled={changing} onClick={() => void change("leave_server")}>Disconnect</button>
            <button type="button" className="settingsPill" disabled={changing || !server.publicKey}
              onClick={() => void change("forget_saved_server", { publicKey: server.publicKey })}>Forget</button>
            <button type="button" className="settingsPill" onClick={() => {
              void flushServerState().then(() => setSetup(true)).catch(reason => setError(String(reason)));
            }}>Add a server</button>
          </div>
        </> : <>
          <p className="settingsMuted">No server connected. Local music, playlists, queues, and settings stay on this device.</p>
          <button type="button" className="settingsPill settingsPillPrimary" disabled={!isTauri()} onClick={() => setSetup(true)}>Add a server</button>
        </>}
      </div>
      {server && sharedPlayback && connected && <PlaybackSessions />}
      <SavedServers saved={saved} changing={changing} onChange={(command, args) => void change(command, args)} />
      <ServerCommandInstall />
    </>}
  </>;
}
