import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { awaitPairing, requestPairing, suggestedAddress, type PairingStarted } from "./client";
import { Swirl } from "./Swirl";

/** Asks the server to pair, shows the code to approve there, and waits. */
export function Pairing({ savedAddress, onPaired }: { savedAddress: string | null; onPaired: () => void }) {
  const [address, setAddress] = useState(() => savedAddress?.replace(/^https?:\/\//, "") || suggestedAddress());
  const [pairing, setPairing] = useState<PairingStarted | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setPairing(null);
    try {
      const started = await requestPairing(address);
      setPairing(started);
      setBusy(false);
      await awaitPairing(started.requestId, controller.signal);
      if (controller.signal.aborted) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onPaired();
    } catch (reason) {
      if (controller.signal.aborted) return;
      setBusy(false);
      setPairing(null);
      setError(reason instanceof Error && reason.name !== "AbortError" ? reason.message : "Couldn't reach the server at that address.");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  return (
    <View style={styles.screen}>
      <Swirl track={null} playing={false} cover={{ current: null }} />
      <KeyboardAvoidingView behavior="padding" style={styles.content}>
        <Text style={styles.title}>Pair with Ambra</Text>
        {pairing ? <>
          <Text style={styles.body}>Approve this code on the computer running the server.</Text>
          <Text style={styles.code} accessibilityLabel={`Code ${pairing.code.split("").join(" ")}`}>{pairing.code}</Text>
          <Text style={styles.hint} selectable>ambra-server pair approve {pairing.code}</Text>
          <Pressable onPress={() => { abort.current?.abort(); setPairing(null); }} style={styles.secondary}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        </> : <>
          <Text style={styles.body}>The address of the Ambra server on your network.</Text>
          <TextInput
            value={address}
            onChangeText={setAddress}
            placeholder={`192.168.1.20:38147`}
            placeholderTextColor="rgba(255, 255, 255, 0.35)"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            keyboardAppearance="dark"
            returnKeyType="go"
            onSubmitEditing={() => void start()}
            style={styles.input}
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable onPress={() => void start()} disabled={busy || !address.trim()} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
            {busy ? <ActivityIndicator color="black" /> : <Text style={styles.primaryText}>Connect</Text>}
          </Pressable>
        </>}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flex: 1, justifyContent: "center", paddingHorizontal: 32, gap: 16 },
  title: { color: "white", fontSize: 28, fontWeight: "700", textAlign: "center" },
  body: { color: "rgba(255, 255, 255, 0.75)", fontSize: 16, textAlign: "center" },
  code: { color: "white", fontSize: 52, fontWeight: "700", letterSpacing: 6, textAlign: "center", fontVariant: ["tabular-nums"] },
  hint: { color: "rgba(255, 255, 255, 0.55)", fontSize: 13, textAlign: "center", fontFamily: "Menlo" },
  input: {
    color: "white",
    fontSize: 17,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
  },
  error: { color: "#ff8a80", fontSize: 14, textAlign: "center" },
  primary: { alignItems: "center", justifyContent: "center", height: 50, borderRadius: 25, backgroundColor: "white" },
  primaryText: { color: "black", fontSize: 17, fontWeight: "600" },
  pressed: { opacity: 0.7 },
  secondary: { alignSelf: "center", padding: 12 },
  secondaryText: { color: "rgba(255, 255, 255, 0.75)", fontSize: 16 },
});
