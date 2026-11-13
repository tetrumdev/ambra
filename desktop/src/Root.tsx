import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import App from "./App";
import { AudioSettingsProvider } from "./hooks/AudioSettingsContext";
import { ClientConnectionContext, type NetworkStatus } from "./hooks/ClientConnectionContext";
import { flushPersistentState, getPersistentItem, hydratePersistentStorage, setPersistentItem } from "./utils/persistentStorage";
import { connectToServer, serverConnection, setServerOnline, subscribeServerConnection, getServerConnection, serverBaseUrl } from "./api/serverConnection";
import { flushServerState, hydrateServerState, installServerStateLifecycle, serverStateStatus, subscribeServerState, reloadServerState } from "./utils/serverState";
import { mark } from "./utils/perf";
import { useStartupWindow } from "./hooks/useStartupWindow";
import { refreshServiceAvailability } from "./hooks/useServiceAvailability";

const sharedPlaybackKey = "ambra.shared-playback.v1";
/** How long a connection attempt may take before the server is shown as disconnected. */
const SETTLE_MS = 20_000;

/**
 * The connection is read every few seconds and nearly always reads the same. Keeping the
 * status it already had keeps the whole app from rendering again each time.
 */
function sameStatus(current: NetworkStatus, next: NetworkStatus) {
  return current.state === next.state && (current.method ?? null) === (next.method ?? null) && (current.error ?? null) === (next.error ?? null)
    ? current : next;
}

/** Local hydration and playback never wait for discovery, authentication, or server state. */
export function Root() {
  const connection = useSyncExternalStore(subscribeServerConnection, getServerConnection);
  const [networkServer, setNetworkServer] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [network, setNetworkStatus] = useState<NetworkStatus>({ state: "Offline" });
  const setNetwork = useCallback((next: NetworkStatus) => setNetworkStatus(current => sameStatus(current, next)), []);
  const [sharedPlayback, setShared] = useState(false);
  const [preferSharedPlayback, setPreferSharedPlayback] = useState(true);
  const [playerGeneration, setPlayerGeneration] = useState(0);
  const playbackMode = useRef(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const changingMode = useRef(Promise.resolve());
  const releasePlayer = useRef<() => Promise<void>>(async () => {});
  const registerPlaybackRelease = useCallback((release: () => Promise<void>) => { releasePlayer.current = release; }, []);
  const connected = networkServer === connection?.baseUrl && network.state.startsWith("Connected");
  // The server that last failed to connect, or took too long to. A server on its way isn't
  // called disconnected: like any app's own server, it's just connecting.
  const [failedServer, setFailedServer] = useState<string | null>(null);
  const settling = !!connection?.server && !connected && failedServer !== connection.baseUrl;
  useEffect(() => {
    if (!settling || !connection) return;
    const server = connection.baseUrl;
    const timer = setTimeout(() => setFailedServer(server), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settling, connection]);
  // Transport availability does not change the selected playback owner. Remounting
  // App on each failed retry resets navigation, layout and open controls. Only an
  // explicit mode or server change should hand an established shared player back.
  const recoveringSharedPlayback = sharedPlayback && !!connection?.server
    && networkServer === connection.baseUrl;
  // Keep the selected server's cached UI through outages. Requests still use the
  // actual reachability below, so unavailable remote tracks cannot start playing.
  const reachable = connected || settling;
  const showServerLibrary = reachable || recoveringSharedPlayback;
  setServerOnline(reachable);
  useStartupWindow(ready);

  const applySharedPlayback = useCallback((shared: boolean) => {
    const change = changingMode.current.then(async () => {
      if (playbackMode.current === shared) return;
      window.dispatchEvent(new Event("ambra:save-session"));
      await releasePlayer.current();
      if (isTauri()) {
        // Stop the previous owner before mounting another controller of the same audio engine.
        await invoke("set_shared_output", { enabled: false });
        await invoke("pause_native_audio");
        if (shared) await invoke("set_shared_output", { enabled: true });
      }
      setModeError(null);
      playbackMode.current = shared;
      setShared(shared);
    });
    changingMode.current = change.catch(async error => {
      if (isTauri()) await invoke("set_shared_output", { enabled: false }).catch(() => {});
      playbackMode.current = false;
      setShared(false);
      setPlayerGeneration(value => value + 1);
      setModeError(String(error));
    });
    return change;
  }, []);

  const setSharedPlayback = useCallback(async (shared: boolean, remember = true) => {
    await applySharedPlayback(shared);
    setPreferSharedPlayback(shared);
    if (!remember) return;
    setPersistentItem(sharedPlaybackKey, String(shared));
    await flushPersistentState();
  }, [applySharedPlayback]);

  const noteOutcome = useCallback((status: NetworkStatus) => {
    if (status.state.startsWith("Connected")) setFailedServer(null);
    else if (status.state === "Failed" || (status.state === "Offline" && status.error)) setFailedServer(serverConnection?.baseUrl ?? null);
  }, []);

  const reconnect = useCallback(() => {
    if (!serverConnection?.server) return;
    const base = serverBaseUrl;
    void invoke<NetworkStatus>("network_connection_status").then(status => {
      if (base !== serverBaseUrl) return;
      setNetworkServer(serverConnection?.baseUrl ?? null); setNetwork(status); noteOutcome(status);
    }).catch(() => { if (base === serverBaseUrl) setNetwork({ state: "Offline" }); });
    void hydrateServerState().catch(() => {});
  }, [setNetwork, noteOutcome]);

  useEffect(() => {
    let disposed = false;
    // The selected server is known before the app first draws, so it opens with that server's
    // cached library rather than switching to it a moment later.
    void connectToServer().catch(() => {}).then(hydratePersistentStorage).finally(() => {
      if (!disposed) {
        setPreferSharedPlayback(getPersistentItem(sharedPlaybackKey) !== "false");
        setReady(true);
        mark("state-hydrated");
      }
    });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    // The status last heard. Given it, the desktop app answers as soon as the status changes
    // (or after a few seconds), so a new connection shows the moment it's made.
    let known: NetworkStatus | null = null;
    const check = async () => {
      let next = 3000;
      try {
        await connectToServer();
        if (disposed) return;
        if (!serverConnection?.server) { known = null; setNetwork({ state: "Offline" }); setNetworkServer(null); return; }
        const selected = serverConnection;
        const asked = Date.now();
        const status = await invoke<NetworkStatus>("network_connection_status", { known, waitMs: 3000 });
        if (disposed || selected !== serverConnection) { known = null; return; }
        // A change is followed at once; an unchanged answer has already waited its turn.
        const unchanged = known !== null && JSON.stringify(known) === JSON.stringify(status);
        next = unchanged ? Math.max(250, 3000 - (Date.now() - asked)) : 0;
        known = status;
        setNetworkServer(serverConnection?.baseUrl ?? null);
        setNetwork(status);
        noteOutcome(status);
        if (status.state.startsWith("Connected")) void hydrateServerState().catch(() => {});
      } catch { known = null; if (!disposed) setNetwork({ state: "Offline" }); }
      finally { if (!disposed) timer = setTimeout(() => void check(), next); }
    };
    void check();
    return () => { disposed = true; clearTimeout(timer); };
  }, [ready, connection, setNetwork, noteOutcome]);
  useEffect(installServerStateLifecycle, []);
  // Asked for while the server was still on its way, the services' sign-in state may not have
  // arrived; ask again now that it answers.
  useEffect(() => { if (connected) void refreshServiceAvailability(); }, [connected]);
  useEffect(() => {
    if (ready) void applySharedPlayback((connected || recoveringSharedPlayback) && preferSharedPlayback).catch(() => {});
  }, [ready, connected, recoveringSharedPlayback, preferSharedPlayback, applySharedPlayback]);

  const client = useMemo(() => ({ connected, network, sharedPlayback, setSharedPlayback, reconnect }),
    [connected, network, sharedPlayback, setSharedPlayback, reconnect]);

  if (!ready) return <main className="stateStartup" aria-busy="true"><div data-window-drag-region className="stateTitlebar" /><h1>Loading local music…</h1></main>;
  return <ClientConnectionContext.Provider value={client}>
    <div className="appViewport"><AudioSettingsProvider>
      <App key={`${sharedPlayback ? "shared" : "local"}:${playerGeneration}`} localOnly={!showServerLibrary} sharedPlayback={sharedPlayback} onPlaybackRelease={registerPlaybackRelease} />
    </AudioSettingsProvider></div>
    {serverConnection?.server && !connected && !settling && <div className="stateSaveError" role="status">
      <span>{serverConnection.server.name} disconnected. Local music remains available.</span>
      <button onClick={reconnect}>Reconnect</button>
    </div>}
    {modeError && <div className="stateSaveError" role="alert">{modeError}</div>}
    <ServerSaveError />
  </ClientConnectionContext.Provider>;
}

function ServerSaveError() {
  const state = useSyncExternalStore(subscribeServerState, serverStateStatus);
  return state.error ? <div className="stateSaveError" role="alert">
    <span>{state.error}</span>
    {state.conflict ? <button onClick={reloadServerState}>Reload server state</button>
      : <button onClick={() => void flushServerState().catch(() => {})}>Retry shared save</button>}
  </div> : null;
}
