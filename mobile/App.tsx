import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SURFACE_BLACK } from "../desktop/src/utils/surfaceBlack";
import { Unpaired, follow, restore } from "./src/client";
import { Pairing } from "./src/Pairing";
import { Player } from "./src/Player";
import { useLiveActivity } from "./src/useLiveActivity";

type Saved = { address: string | null; paired: boolean };

export default function App() {
  const [saved, setSaved] = useState<Saved | null>(null);
  useLiveActivity(saved?.paired ?? false);
  useEffect(() => { void restore().then(setSaved); }, []);

  useEffect(() => {
    if (!saved?.paired) return;
    const abort = new AbortController();
    void follow(abort.signal).catch(error => {
      if (error instanceof Unpaired) setSaved(current => current && { ...current, paired: false });
    });
    return () => abort.abort();
  }, [saved?.paired]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: SURFACE_BLACK }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {!saved ? <View /> : saved.paired
          ? <Player />
          : <Pairing savedAddress={saved.address} onPaired={() => setSaved(current => ({ address: current?.address ?? null, paired: true }))} />}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
