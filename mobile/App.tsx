import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
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
  usePhoneOutput(saved?.paired ?? false);
  useEffect(() => { void restore().then(setSaved).catch(error => { setNetworkError(String(error)); setSaved({ address: null, paired: false }); }); }, []);

  useEffect(() => {
    if (!saved?.paired) return;
    let disposed = false;
    const refresh = () => void networkStatus().then(status => {
      if (!disposed) setNetworkError(status.state.startsWith("Connected") ? null : status.error ?? `Server ${status.state.toLowerCase()}`);
    }).catch(error => { if (!disposed) setNetworkError(String(error)); });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [saved?.paired]);

  useEffect(() => {
    if (!saved?.paired) return;
    const abort = new AbortController();
    void follow(abort.signal).catch(error => {
      if (error instanceof Unpaired) setSaved(current => current && { ...current, paired: false });
    });
    return () => abort.abort();
  }, [saved?.paired]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.black }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {networkError && <Text accessibilityRole="alert" style={{ color: "white", padding: 24 }}>{networkError}</Text>}
        {!saved || (!fontsLoaded && !fontError) ? <View /> : saved.paired
          ? <Player />
          : <Pairing savedAddress={saved.address} onPaired={() => setSaved(current => ({ address: current?.address ?? null, paired: true }))} />}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
