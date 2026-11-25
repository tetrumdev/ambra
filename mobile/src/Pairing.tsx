import { useEffect, useRef, useState } from "react";
import Constants from "expo-constants";
import { CameraView, useCameraPermissions } from "expo-camera";
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { awaitPairing, requestPairing, type PairingStarted } from "./client";
import { Swirl } from "./Swirl";
import { colors, fonts, haptic, space, textSize } from "./theme";
import { Button, Field } from "./DesignControls";
import { Touchable } from "./Touchable";

/** Asks the server to pair, shows the code to approve there, and waits. */
export function Pairing({ savedAddress, onPaired, onCancel, initialError = null }: { savedAddress: string | null; onPaired: () => void; onCancel?: () => void; initialError?: string | null }) {
  const [address, setAddress] = useState(() => savedAddress?.startsWith("ambra://pair/") ? savedAddress : "");
  const [pairing, setPairing] = useState<PairingStarted | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const abort = useRef<AbortController | null>(null);
  // The camera reports a code many times a second; pair once per opening.
  const scanned = useRef(false);
  useEffect(() => () => abort.current?.abort(), []);

  const start = async (link = address) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setPairing(null);
    try {
      const started = await requestPairing(link, Constants.deviceName || (Platform.OS === "ios" ? "iPhone" : "Android phone"), controller.signal);
      if (controller.signal.aborted) return;
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
      <Swirl track={null} playing={false} />
      <KeyboardAvoidingView behavior="padding" style={styles.content}>
        <Text style={styles.title}>Pair with Ambra</Text>
        {onCancel && <Touchable accessibilityRole="button" onPress={() => { abort.current?.abort(); onCancel(); }} style={styles.secondary}><Text style={styles.secondaryText}>Back to current server</Text></Touchable>}
        {pairing ? <>
          <Text style={styles.body}>Approve this code on the computer running the server.</Text>
          <Text style={styles.code} accessibilityLabel={`Code ${pairing.code.split("").join(" ")}`}>{pairing.code}</Text>
          <Text style={styles.hint} selectable>ambra-server pair approve {pairing.code}</Text>
          <Touchable accessibilityRole="button" onPress={() => { abort.current?.abort(); setPairing(null); }} style={styles.secondary}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </Touchable>
        </> : <>
          <Text style={styles.body}>Scan the QR code from ambra-server pair qr, or paste its link. Then approve the six-digit code on that server.</Text>
          {scanning && permission?.granted && <CameraView style={{ height: 240, width: "100%" }} barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => { if (scanned.current) return; if (data.startsWith("ambra://pair/")) { scanned.current = true; setAddress(data); setScanning(false); void start(data); } else setError("This QR code is not an Ambra pairing link."); }} />}
          <Touchable accessibilityRole="button" onPress={() => void (async () => { const next = permission?.granted ? permission : await requestPermission(); if (next.granted) { scanned.current = false; setScanning(value => !value); } else setError("Allow camera access to scan, or paste the pairing link."); })()} style={styles.secondary}>
            <Text style={styles.secondaryText}>{scanning ? "Close camera" : "Scan server QR code"}</Text>
          </Touchable>
          <Field
            value={address}
            onChangeText={setAddress}
            placeholder="ambra://pair/…"
            accessibilityLabel="Server pairing link"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={() => void start()}
          />
          {error && <Text style={styles.error}>{error}</Text>}
          <Button title={busy ? "Connecting" : "Connect"} variant="primary" haptic="firm" hapticOnPressIn
            onPress={() => void start()} disabled={busy || !address.trim()}>
            {busy && <ActivityIndicator color={colors.black} />}
          </Button>
        </>}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  content: { flex: 1, justifyContent: "center", paddingHorizontal: 32, gap: space.lg },
  title: { color: colors.text, fontFamily: fonts.serif, fontSize: 40, fontWeight: "500", textAlign: "center" },
  body: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: "center" },
  code: { color: colors.text, fontFamily: fonts.sans, fontSize: 52, fontWeight: "700", letterSpacing: 6, textAlign: "center", fontVariant: ["tabular-nums"] },
  hint: { color: colors.muted, fontSize: textSize.detail, textAlign: "center", fontFamily: "Menlo" },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: textSize.small, textAlign: "center" },
  secondary: { alignSelf: "center", padding: 12 },
  secondaryText: { color: colors.secondary, fontFamily: fonts.sans, fontSize: 15, fontWeight: "600" },
});
