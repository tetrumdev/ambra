import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Unpaired, follow, restore, networkStatus, playingHere, serverAnswering, subscribeReachability, wantsOffline, sendDiagnostics, drainBridgeDiagnostics } from "./src/client";
import { diag, startDiagnostics } from "./src/diagnostics";
import * as FileSystem from "expo-file-system/legacy";
import { deviceOnline, subscribeDevicePath } from "./modules/ambra-network/src";
import { Pairing } from "./src/Pairing";
import { Player } from "./src/Player";
import { colors } from "./src/theme";
import { usePhoneOutput } from "./src/usePhoneOutput";
import { followPhoneDownloads, refreshServerDownloads, startPhoneDownloads, useDownloads } from "./src/downloads";
import { refreshLibrary } from "./src/library";
import { forgetState } from "./src/sharedState";
import { useOfflineSession } from "./src/offlineSession";

/**
 * The server counts as away after this long out of reach, and downloads play from the phone;
 * at once when the phone has no network at all. A song this phone is already playing from the
 * server plays on (it's downloaded ahead) and the switch waits for it to stop.
 */
const OFFLINE_AFTER_MS = 5_000;

/** TEMPORARY: unsent playback diagnostics, kept on disk across restarts. */
const DIAGNOSTICS_FILE = `${FileSystem.documentDirectory}ambra-diagnostics.json`;
const diagnosticsStore = {
  load: () => FileSystem.readAsStringAsync(DIAGNOSTICS_FILE).catch(() => null),
  save: (text: string | null) => text ? FileSystem.writeAsStringAsync(DIAGNOSTICS_FILE, text) : FileSystem.deleteAsync(DIAGNOSTICS_FILE, { idempotent: true }),
};

type Saved = { address: string | null; paired: boolean };

export default function App() {
  const [fontsLoaded, fontError] = useFonts([
    { fontFamily: "Source Serif 4", fontDefinitions: [{ path: require("../desktop/src/assets/fonts/SourceSerif4Variable-Roman.ttf") }] },
    { fontFamily: "Stack Sans Text", fontDefinitions: [{ path: require("../desktop/src/assets/fonts/StackSansText-VariableFont_wght.ttf") }] },
  ]);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [changingServer, setChangingServer] = useState(false);
  const paired = !!saved?.paired && !changingServer;
  usePhoneOutput(paired);
  const [unreachableSince, setUnreachableSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [cut, setCut] = useState(false);
  const [busy, setBusy] = useState(false);
  // A play or skip the server didn't answer: downloads take over at once.
  const [wanted, setWanted] = useState(false);
  const { phone } = useDownloads();
  const offline = paired && unreachableSince !== null && phone.size > 0 && (wanted || (!busy && (cut || now - unreachableSince >= OFFLINE_AFTER_MS)));
  useOfflineSession(offline);
  const offlineRef = useRef(offline);
  useEffect(() => { offlineRef.current = offline; diag("app.offline_session", { active: offline, unreachableSince, wanted, busy, cut }); }, [offline]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void startPhoneDownloads(); }, []);
  // TEMPORARY: playback diagnostics go to the server's log while paired.
  useEffect(() => paired ? startDiagnostics(sendDiagnostics, drainBridgeDiagnostics, diagnosticsStore) : undefined, [paired]);
  useEffect(() => {
    if (!paired) return;
    forgetState();
    void refreshLibrary();
    void refreshServerDownloads();
    return followPhoneDownloads();
  }, [paired]);
  useEffect(() => {
    if (unreachableSince === null) return;
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(timer);
  }, [unreachableSince]);
  useEffect(() => {
    let disposed = false;
    void restore().then(value => { if (!disposed) setSaved(value); }).catch(error => {
      if (!disposed) { setNetworkError(String(error)); setSaved({ address: null, paired: false }); }
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!paired) return;
    let disposed = false;
    let away = false;
    let lastSeen = "";
    const refresh = () => void networkStatus().then(status => {
      if (disposed) return;
      const noNetwork = !deviceOnline();
      const connected = !noNetwork && status.state.startsWith("Connected") && serverAnswering();
      const seen = JSON.stringify([noNetwork, status.state, status.method, status.error, serverAnswering()]);
      if (seen !== lastSeen) { lastSeen = seen; diag("app.network_status", { noNetwork, status, answering: serverAnswering(), offlineSession: offlineRef.current }); }
      setCut(noNetwork);
      setBusy(!connected && playingHere());
      setWanted(!connected && wantsOffline());
      setNetworkError(connected ? null : noNetwork ? "No network" : status.error ?? (status.state.startsWith("Connected") ? "The server isn't answering" : `Server ${status.state.toLowerCase()}`));
      // Back from being away: what changed meanwhile is loaded again. (Not inside the state
      // updater: the library publishing there updates other components mid-render.)
      if (connected && away) void refreshLibrary();
      away = !connected;
      setUnreachableSince(current => connected ? null : current ?? Date.now());
    }).catch(error => { if (!disposed) { away = true; setNetworkError(String(error)); setUnreachableSince(current => current ?? Date.now()); } });
    // Every 3 s on screen; in the background, where only the switch to downloads depends on it,
    // every 15 s, so it doesn't wake the phone for nothing.
    let timer: ReturnType<typeof setTimeout>;
    const next = () => { timer = setTimeout(() => { refresh(); next(); }, AppState.currentState === "active" ? 3000 : 15_000); };
    refresh();
    next();
    const state = AppState.addEventListener("change", current => { if (current === "active") { clearTimeout(timer); refresh(); next(); } });
    // Losing the network, or a request finding the server gone, is looked at straight away.
    const path = subscribeDevicePath(refresh);
    const reach = subscribeReachability(refresh);
    return () => { disposed = true; clearTimeout(timer); state.remove(); path(); reach(); };
  }, [paired]);

  useEffect(() => {
    if (!paired) return;
    const abort = new AbortController();
    void follow(abort.signal).catch(error => {
      if (!abort.signal.aborted && error instanceof Unpaired) setSaved(current => current && { ...current, paired: false });
    });
    return () => abort.abort();
  }, [paired]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.black }}>
      <SafeAreaProvider style={{ flex: 1 }}>
        <StatusBar style="light" />
        {!saved || (!fontsLoaded && !fontError) ? <View style={{ flex: 1 }} /> : paired
          ? <Player connectionError={networkError} onChangeServer={() => { setNetworkError(null); setChangingServer(true); }} />
          : <Pairing savedAddress={changingServer ? null : saved.address} initialError={networkError}
            onCancel={changingServer ? () => {
              void restore().then(value => { setSaved(value); setNetworkError(null); setChangingServer(false); }).catch(error => setNetworkError(String(error)));
            } : undefined}
            onPaired={() => { setNetworkError(null); setChangingServer(false); setSaved(current => ({ address: current?.address ?? null, paired: true })); }} />}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
