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
      if (!disposed) setNetworkError(status.state.startsWith("Connected") ? null : status.error ?? `Server ${status.state.toLowerCase()}`);
    }).catch(error => { if (!disposed) setNetworkError(String(error)); });
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
