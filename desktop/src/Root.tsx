import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import App from "./App";
import { AudioSettingsProvider } from "./hooks/AudioSettingsContext";
import { ClientConnectionContext, type NetworkStatus } from "./hooks/ClientConnectionContext";
import { hydratePersistentStorage } from "./utils/persistentStorage";
import { connectToServer, serverConnection, setServerOnline } from "./api/serverConnection";
import { flushServerState, hydrateServerState, installServerStateLifecycle, serverStateStatus, subscribeServerState, reloadServerState } from "./utils/serverState";
import { mark } from "./utils/perf";
import { useStartupWindow } from "./hooks/useStartupWindow";

/** Local hydration and playback never wait for discovery, authentication, or server state. */
export function Root() {
  const [ready, setReady] = useState(false);
  const [network, setNetwork] = useState<NetworkStatus>({ state: "Offline" });
  const [sharedPlayback, setShared] = useState(false);
  const [playerGeneration, setPlayerGeneration] = useState(0);
  const playbackMode = useRef(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const changingMode = useRef(Promise.resolve());
  const releasePlayer = useRef<() => Promise<void>>(async () => {});
  const registerPlaybackRelease = useCallback((release: () => Promise<void>) => { releasePlayer.current = release; }, []);
  const connected = network.state.startsWith("Connected");
  setServerOnline(connected);
  useStartupWindow(ready);

  const setSharedPlayback = useCallback((shared: boolean) => {
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

  const reconnect = useCallback(() => {
    if (!serverConnection?.server) return;
    void invoke<NetworkStatus>("network_connection_status").then(setNetwork).catch(() => setNetwork({ state: "Offline" }));
    void hydrateServerState().catch(() => {});
  }, []);

  useEffect(() => {
    let disposed = false;
    void hydratePersistentStorage().finally(() => {
      if (!disposed) { setReady(true); mark("state-hydrated"); }
    });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        await connectToServer();
        if (!serverConnection?.server) return;
        const status = await invoke<NetworkStatus>("network_connection_status");
        if (disposed) return;
        setNetwork(status);
        if (status.state.startsWith("Connected")) void hydrateServerState().catch(() => {});
      } catch { if (!disposed) setNetwork({ state: "Offline" }); }
      finally { if (!disposed) timer = setTimeout(() => void check(), 3000); }
    };
    void check();
    return () => { disposed = true; clearTimeout(timer); };
  }, [ready]);
  useEffect(installServerStateLifecycle, []);
  useEffect(() => {
    if (!connected && sharedPlayback) void setSharedPlayback(false);
  }, [connected, sharedPlayback, setSharedPlayback]);

  if (!ready) return <main className="stateStartup" aria-busy="true"><div data-tauri-drag-region className="stateTitlebar" /><h1>Loading local music…</h1></main>;
  return <ClientConnectionContext.Provider value={{ connected, network, sharedPlayback, setSharedPlayback, reconnect }}>
    <div className="appViewport"><AudioSettingsProvider>
      <App key={`${sharedPlayback ? "shared" : "local"}:${playerGeneration}`} localOnly={!connected} sharedPlayback={sharedPlayback} onPlaybackRelease={registerPlaybackRelease} />
    </AudioSettingsProvider></div>
    {serverConnection?.server && !connected && <div className="stateSaveError" role="status">
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
