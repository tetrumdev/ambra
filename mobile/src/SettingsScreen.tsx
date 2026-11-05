import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import Constants from "expo-constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ServiceAuthStatus } from "../../desktop/src/api/server";
import { musicProviderName } from "../../desktop/src/utils/musicProviderName";
import { serverInfo, serviceStatus } from "./catalog";
import { networkStatus } from "./client";
import { loadServicePreferences, services, servicePreferences, setServiceEnabled, subscribeServicePreferences, type Service } from "./servicePreferences";
import { Touchable } from "./Touchable";
import { useNavigation } from "./navigation";
import { useDownloads } from "./downloads";
import { signIn, signOut } from "./playlistTools";
import { refreshLibrary } from "./library";
import { colors, fonts } from "./theme";

export function SettingsScreen({ bottomInset, onChangeServer }: { bottomInset: number; onChangeServer: () => void }) {
  const insets = useSafeAreaInsets();
  const { push } = useNavigation();
  const { phone, active } = useDownloads();
  const downloadedBytes = [...phone.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const enabled = useSyncExternalStore(subscribeServicePreferences, servicePreferences);
  const [server, setServer] = useState("Selected server");
  const [connection, setConnection] = useState("Checking connection…");
  const [connected, setConnected] = useState<ServiceAuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Service | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void loadServicePreferences().catch(reason => { if (!abort.signal.aborted) setError(String(reason)); });
    void Promise.allSettled([serverInfo(abort.signal), serviceStatus(abort.signal), networkStatus()]).then(results => {
      if (abort.signal.aborted) return;
      const [info, status, network] = results;
      if (info.status === "fulfilled") setServer(info.value.name || "Ambra server");
      if (status.status === "fulfilled") setConnected(status.value);
      if (network.status === "fulfilled") setConnection(network.value.state.startsWith("Connected") ? `Connected${network.value.method ? ` · ${network.value.method}` : ""}` : network.value.error ?? "Server offline");
      if (info.status === "rejected" || status.status === "rejected") setError("Couldn't read server settings. Check the connection and retry.");
      setLoading(false);
    });
    return () => abort.abort();
  }, [attempt]);
  // Desktop's Services page: sign in through an in-app browser; credentials stay on the server.
  const [signingIn, setSigningIn] = useState<Service | null>(null);
  const [paste, setPaste] = useState<((url: string) => Promise<void>) | null>(null);
  const [pasted, setPasted] = useState("");
  const [serviceMessage, setServiceMessage] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const startSignIn = (service: Service) => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setSigningIn(service); setServiceMessage(null); setError(null); setPasted("");
    void signIn(service, controller.signal, submit => setPaste(() => submit))
      .then(() => {
        setConnected(current => ({ tidal: false, qobuz: false, spotify: false, ...current, [service]: true }));
        setServiceMessage(`${musicProviderName(service)} connected.`);
        void refreshLibrary();
      })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { if (pending.current === controller) { pending.current = null; setSigningIn(null); setPaste(null); } });
  };
  const cancelSignIn = () => { pending.current?.abort(); pending.current = null; setSigningIn(null); setPaste(null); setServiceMessage("Sign-in cancelled."); };
  const disconnect = (service: Service) => {
    setBusy(service); setError(null);
    void signOut(service).then(() => setConnected(current => current && { ...current, [service]: false }))
      .catch(failure => setError(failure instanceof Error ? failure.message : "Couldn't sign out.")).finally(() => setBusy(null));
  };
  const toggle = (service: Service, value: boolean) => {
    setBusy(service);
    setError(null);
    void setServiceEnabled(service, value).catch(reason => setError(reason instanceof Error ? reason.message : "Couldn't save this setting.")).finally(() => setBusy(null));
  };
  return <ScrollView style={styles.screen} contentContainerStyle={{ paddingTop: insets.top + 24, paddingHorizontal: 24, paddingBottom: bottomInset + 24 }}>
    <Text accessibilityRole="header" style={styles.title}>Settings</Text>
    <Text style={styles.intro}>Your server. Your music.</Text>
    <Text accessibilityRole="header" style={styles.sectionTitle}>Server</Text>
    <View style={styles.card}>
      <Text style={styles.name}>{server}</Text>
      <Text style={styles.detail}>{connection}</Text>
      <Touchable accessibilityRole="button" accessibilityLabel="Connect to a different server" onPress={onChangeServer} style={styles.button}>
        <Text style={styles.buttonText}>Change server</Text>
      </Touchable>
    </View>
    <Text style={styles.note}>Scan another server’s QR code or paste its pairing link. You can cancel and return to this server.</Text>
    <Text accessibilityRole="header" style={styles.sectionTitle}>Music services</Text>
    <View style={styles.card}>
      {services.map((service, index) => <View key={service} style={[styles.service, index > 0 && styles.divider]}>
        <View style={styles.serviceText}>
          <Text style={styles.name}>{musicProviderName(service)}</Text>
          <Text style={styles.detail}>{!enabled[service] ? "Off on this phone" : connected ? connected[service] ? "Connected on server" : "Not connected on server" : "Checking server…"}</Text>
        </View>
        {connected && (connected[service]
          ? <Touchable accessibilityRole="button" accessibilityLabel={`Sign out of ${musicProviderName(service)}`} disabled={busy !== null || signingIn !== null} onPress={() => disconnect(service)} style={styles.pill}><Text style={styles.pillText}>Sign out</Text></Touchable>
          : <Touchable accessibilityRole="button" accessibilityLabel={`Sign in to ${musicProviderName(service)}`} disabled={signingIn !== null} onPress={() => startSignIn(service)} style={[styles.pill, styles.pillPrimary]}><Text style={[styles.pillText, styles.pillPrimaryText]}>{signingIn === service ? "Waiting…" : "Sign in"}</Text></Touchable>)}
        <Switch accessibilityLabel={`Use ${musicProviderName(service)} on this phone`} value={enabled[service]} disabled={busy !== null} onValueChange={value => toggle(service, value)} trackColor={{ false: "#343434", true: "#876428" }} thumbColor="white" />
      </View>)}
    </View>
    <Text style={styles.note}>Switches hide a service’s songs and exclude it from search on this phone. They do not sign out the server, stop another device, or change the shared queue.</Text>
    {signingIn && <View style={styles.signIn}>
      <Text style={styles.note}>Finish signing in to {musicProviderName(signingIn)} in the browser.</Text>
      {paste && <>
        <Text style={styles.note}>After signing in to Tidal, copy the final address from the browser’s address bar and paste it here.</Text>
        <TextInput value={pasted} onChangeText={setPasted} placeholder="https://tidal.com/android/login/auth?code=…" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} keyboardAppearance="dark" style={styles.input} accessibilityLabel="Tidal sign-in address" />
        <Touchable accessibilityRole="button" disabled={!pasted.trim()} onPress={() => void paste(pasted).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))} style={styles.button}><Text style={styles.buttonText}>Finish sign-in</Text></Touchable>
      </>}
      <Touchable accessibilityRole="button" onPress={cancelSignIn} style={styles.button}><Text style={styles.buttonText}>Cancel</Text></Touchable>
    </View>}
    {serviceMessage && <Text accessibilityRole="alert" style={styles.note}>{serviceMessage}</Text>}
    <Text style={styles.note}>Sign in here or on desktop. Credentials stay on your server.</Text>
    <Text accessibilityRole="header" style={styles.sectionTitle}>Downloads</Text>
    <View style={styles.card}>
      <Text style={styles.name}>{phone.size} {phone.size === 1 ? "song" : "songs"} on this phone</Text>
      <Text style={styles.detail}>{(downloadedBytes / 1024 ** 3).toFixed(2)} GB, encrypted{active ? ` · downloading ${active.done + 1} of ${active.total}` : ""}</Text>
      <Touchable accessibilityRole="button" onPress={() => push({ kind: "downloads" })} style={styles.button}>
        <Text style={styles.buttonText}>Manage downloads</Text>
      </Touchable>
    </View>
    <Text style={styles.note}>Downloaded songs play without a server. They are encrypted with this phone’s own key, so the files can’t be copied out and played elsewhere.</Text>
    {loading && <ActivityIndicator color={colors.muted} style={styles.loading} />}
    {error && <View style={styles.errorBox}><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Touchable accessibilityRole="button" onPress={() => { setLoading(true); setError(null); setAttempt(value => value + 1); }} style={styles.retry}><Text style={styles.buttonText}>Retry</Text></Touchable></View>}
    <Text style={styles.version}>AMBRA {Constants.expoConfig?.version ?? ""}</Text>
  </ScrollView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  title: { color: "white", fontFamily: fonts.serif, fontSize: 38 },
  intro: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, marginTop: 8, marginBottom: 12 },
  sectionTitle: { color: "white", fontFamily: fonts.sans, fontSize: 18, fontWeight: "600", marginTop: 28, marginBottom: 12 },
  card: { backgroundColor: "#151515", borderColor: "#2f2f2f", borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 8 },
  name: { color: "white", fontFamily: fonts.sans, fontSize: 16, marginTop: 8 },
  detail: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, marginTop: 5, marginBottom: 8 },
  note: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, marginTop: 12 },
  button: { minHeight: 44, justifyContent: "center", alignItems: "center", backgroundColor: "#292929", borderRadius: 8, marginVertical: 8 },
  buttonText: { color: "white", fontFamily: fonts.sans, fontSize: 14, fontWeight: "500" },
  service: { flexDirection: "row", alignItems: "center", minHeight: 72, gap: 16 },
  serviceText: { flex: 1 },
  divider: { borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth },
  errorBox: { marginTop: 20, gap: 8 },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 14 },
  retry: { alignSelf: "flex-start", paddingVertical: 12, paddingRight: 24 },
  loading: { marginTop: 16 },
  pill: { minHeight: 34, paddingHorizontal: 14, borderRadius: 100, borderWidth: 1, borderColor: "#3a3a3a", alignItems: "center", justifyContent: "center" },
  pillPrimary: { backgroundColor: "white", borderColor: "white" },
  pillText: { color: "white", fontFamily: fonts.sans, fontSize: 13, fontWeight: "600" },
  pillPrimaryText: { color: "black" },
  signIn: { marginTop: 12, gap: 4 },
  input: { minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: "#2f2f2f", backgroundColor: "#151515", color: "white", fontFamily: fonts.sans, fontSize: 14, paddingHorizontal: 12, marginTop: 8 },
  version: { color: colors.faint, fontFamily: fonts.sans, fontSize: 12, marginTop: 32 },
});
