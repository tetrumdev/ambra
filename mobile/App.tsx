import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Unpaired, follow, restore, networkStatus } from "./src/client";
import { Pairing } from "./src/Pairing";
import { Player } from "./src/Player";
import { colors } from "./src/theme";
import { usePhoneOutput } from "./src/usePhoneOutput";
import { followPhoneDownloads, refreshServerDownloads, startPhoneDownloads, useDownloads } from "./src/downloads";
import { refreshLibrary } from "./src/library";
import { forgetState } from "./src/sharedState";
import { useOfflineSession } from "./src/offlineSession";

/** The server counts as away after this long out of reach, and downloads play from the phone. */
const OFFLINE_AFTER_MS = 10_000;

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
  const { phone } = useDownloads();
  const offline = paired && unreachableSince !== null && now - unreachableSince >= OFFLINE_AFTER_MS && phone.size > 0;
  useOfflineSession(offline);
  useEffect(() => { void startPhoneDownloads(); }, []);
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
    const refresh = () => void networkStatus().then(status => {
      if (disposed) return;
      const connected = status.state.startsWith("Connected");
      setNetworkError(connected ? null : status.error ?? `Server ${status.state.toLowerCase()}`);
      setUnreachableSince(current => {
        if (!connected) return current ?? Date.now();
        // Back from being away: what changed meanwhile is loaded again.
        if (current !== null) void refreshLibrary();
        return null;
      });
    }).catch(error => { if (!disposed) { setNetworkError(String(error)); setUnreachableSince(current => current ?? Date.now()); } });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { disposed = true; clearInterval(timer); };
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
