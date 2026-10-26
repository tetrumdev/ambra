import { useEffect, useRef, useState } from "react";
import Constants from "expo-constants";
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { awaitPairing, requestPairing, suggestedAddress, type PairingStarted } from "./client";
import { Swirl } from "./Swirl";
import { colors, fonts, haptic } from "./theme";
import { Touchable } from "./Touchable";

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
      const started = await requestPairing(address, Constants.deviceName || (Platform.OS === "ios" ? "iPhone" : "Android phone"));
      setPairing(started);
      setBusy(false);
      await awaitPairing(started.requestId, controller.signal);
      if (controller.signal.aborted) return;
      haptic.success();
      onPaired();
    } catch (reason) {
      if (controller.signal.aborted) return;
      setBusy(false);
      setPairing(null);
      setError(reason instanceof Error && reason.name !== "AbortError" ? reason.message : "Couldn't reach the server at that address.");
      haptic.error();
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
          <Touchable accessibilityRole="button" onPress={() => { abort.current?.abort(); setPairing(null); }} style={styles.secondary}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </Touchable>
        </> : <>
          <Text style={styles.body}>The address of the Ambra server on your network, or its Tailscale name or IP to reach it from anywhere.</Text>
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
          <Touchable accessibilityRole="button" haptic="firm" hapticOnPressIn onPress={() => void start()} disabled={busy || !address.trim()} style={styles.primary}>
            {busy ? <ActivityIndicator color="black" /> : <Text style={styles.primaryText}>Connect</Text>}
          </Touchable>
        </>}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  content: { flex: 1, justifyContent: "center", paddingHorizontal: 32, gap: 16 },
  title: { color: "white", fontFamily: fonts.serif, fontSize: 40, fontWeight: "500", textAlign: "center" },
  body: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: "center" },
  code: { color: "white", fontFamily: fonts.sans, fontSize: 52, fontWeight: "700", letterSpacing: 6, textAlign: "center", fontVariant: ["tabular-nums"] },
  hint: { color: colors.muted, fontSize: 13, textAlign: "center", fontFamily: "Menlo" },
  input: {
    color: "white",
    fontFamily: fonts.sans,
    fontSize: 17,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 100,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2f2f2f",
    backgroundColor: colors.raised,
  },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 14, textAlign: "center" },
  primary: { alignItems: "center", justifyContent: "center", height: 50, borderRadius: 100, backgroundColor: "white" },
  primaryText: { color: "black", fontFamily: fonts.sans, fontSize: 16, fontWeight: "600" },
  secondary: { alignSelf: "center", padding: 12 },
  secondaryText: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 15, fontWeight: "600" },
});
