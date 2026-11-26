import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Animated, StyleSheet, Switch, Text, View, useAnimatedValue } from "react-native";
import Constants from "expo-constants";
import type { ServiceAuthStatus } from "../../desktop/src/api/server";
import { musicProviderName } from "../../desktop/src/utils/musicProviderName";
import { serverInfo, serviceStatus } from "./catalog";
import { connectionMethod, directMode, networkStatus, setConnectionMethod, type ConnectionMethod } from "./client";
import { Segmented } from "./shell/Segmented";

import { loadServicePreferences, services, servicePreferences, setServiceEnabled, subscribeServicePreferences, type Service } from "./servicePreferences";
import { Button, Field } from "./DesignControls";
import { Touchable } from "./Touchable";
import { CompactBar, PageHeader, useNavigation } from "./navigation";
import { useDownloads } from "./downloads";
import { signIn, signOut } from "./playlistTools";
import { refreshLibrary } from "./library";
import { colors, fonts, radius, space, textSize } from "./theme";

// As desktop's Server settings name them. pwnat needs raw sockets, which phones don't allow.
const methodItems: { value: ConnectionMethod | "auto"; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "Lan", label: "Local network" },
  { value: "Public", label: "Internet (direct)" },
  { value: "HyperDHT", label: "HyperDHT" },
  { value: "TcpPunch", label: "Direct TCP (Nostr)" },
  { value: "Tailcat", label: "Tailcat" },
];

export function SettingsScreen({ onChangeServer }: { onChangeServer: () => void }) {
  const { push, bottomInset } = useNavigation();
  const scroll = useAnimatedValue(0);
  const { phone, active } = useDownloads();
  const downloadedBytes = [...phone.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const enabled = useSyncExternalStore(subscribeServicePreferences, servicePreferences);
  const [server, setServer] = useState("Selected server");
  const [connection, setConnection] = useState("Checking connection…");
  const [method, setMethod] = useState<ConnectionMethod | "auto">(() => connectionMethod() ?? "auto");
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
  return <View style={styles.screen}><Animated.ScrollView style={styles.screen} scrollEventThrottle={16} onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scroll } } }], { useNativeDriver: true })}
    contentContainerStyle={{ paddingBottom: bottomInset + 24 }}>
    <View style={styles.offset}><PageHeader title="Settings" subtitle="Your server. Your music." scroll={scroll} /></View>
    <View style={styles.body}>
    <Text accessibilityRole="header" style={styles.sectionTitle}>Server</Text>
    <View style={styles.card}>
      <Text style={styles.name}>{server}</Text>
      <Text style={styles.detail}>{connection}{directMode ? " · Expo Go" : ""}</Text>
      <Button title="Change server" accessibilityLabel="Connect to a different server" onPress={onChangeServer} style={styles.button} />
    </View>
    {!directMode && <View style={styles.methods}>
      <Segmented<ConnectionMethod | "auto"> label="Connection type" value={method} items={methodItems} onChange={next => {
        setMethod(next);
        setConnection("Reconnecting…");
        void setConnectionMethod(next === "auto" ? null : next).catch(failure => setError(String(failure))).finally(() => setAttempt(value => value + 1));
      }} />
    </View>}
    <Text accessibilityRole="header" style={styles.sectionTitle}>Music services</Text>
    <View style={styles.card}>
      {services.map((service, index) => <View key={service} style={[styles.service, index > 0 && styles.divider]}>
        <View style={styles.serviceText}>
          <Text style={styles.name}>{musicProviderName(service)}</Text>
          <Text style={styles.detail}>{!enabled[service] ? "Off on this phone" : connected ? connected[service] ? "Connected on server" : "Not connected on server" : "Checking server…"}</Text>
        </View>
        {connected && (connected[service]
          ? <Button title="Sign out" accessibilityLabel={`Sign out of ${musicProviderName(service)}`} disabled={busy !== null || signingIn !== null} onPress={() => disconnect(service)} />
          : <Button title={signingIn === service ? "Waiting…" : "Sign in"} variant="primary" accessibilityLabel={`Sign in to ${musicProviderName(service)}`} disabled={signingIn !== null} onPress={() => startSignIn(service)} />)}
        <Switch accessibilityLabel={`Use ${musicProviderName(service)} on this phone`} value={enabled[service]} disabled={busy !== null} onValueChange={value => toggle(service, value)} trackColor={{ false: "#262626", true: "#876428" }} thumbColor={colors.text} />
      </View>)}
    </View>
    {signingIn && <View style={styles.signIn}>
      <Text style={styles.note}>Finish signing in to {musicProviderName(signingIn)} in the browser.</Text>
      {paste && <>
        <Text style={styles.note}>After signing in to Tidal, copy the final address from the browser’s address bar and paste it here.</Text>
        <Field value={pasted} onChangeText={setPasted} placeholder="https://tidal.com/android/login/auth?code=…" autoCapitalize="none" autoCorrect={false} style={styles.input} accessibilityLabel="Tidal sign-in address" />
        <Button title="Finish sign-in" disabled={!pasted.trim()} onPress={() => void paste(pasted).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))} style={styles.button} />
      </>}
      <Button title="Cancel" onPress={cancelSignIn} style={styles.button} />
    </View>}
    {serviceMessage && <Text accessibilityRole="alert" style={styles.note}>{serviceMessage}</Text>}
    <Text accessibilityRole="header" style={styles.sectionTitle}>Downloads</Text>
    <View style={styles.card}>
      <Text style={styles.name}>{phone.size} {phone.size === 1 ? "song" : "songs"} on this phone</Text>
      <Text style={styles.detail}>{(downloadedBytes / 1024 ** 3).toFixed(2)} GB, encrypted{active ? ` · downloading ${active.done + 1} of ${active.total}` : ""}</Text>
      <Button title="Manage downloads" onPress={() => push({ kind: "downloads" })} style={styles.button} />
    </View>
    {loading && <ActivityIndicator color={colors.muted} style={styles.loading} />}
    {error && <View style={styles.errorBox}><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Touchable accessibilityRole="button" onPress={() => { setLoading(true); setError(null); setAttempt(value => value + 1); }} style={styles.retry}><Text style={styles.buttonText}>Retry</Text></Touchable></View>}
    <Text style={styles.version}>AMBRA {Constants.expoConfig?.version ?? ""}</Text>
    </View>
  </Animated.ScrollView><CompactBar title="Settings" scroll={scroll} /></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  offset: { marginHorizontal: 0 },
  body: { paddingHorizontal: 20 },
  sectionTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 18, fontWeight: "600", marginTop: 28, marginBottom: 12 },
  methods: { marginHorizontal: -20, marginTop: 10 },
  card: { backgroundColor: colors.raised, borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, borderCurve: "continuous", paddingHorizontal: 16, paddingVertical: 8 },
  name: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.body, marginTop: 8 },
  detail: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.detail, marginTop: 5, marginBottom: 8 },
  note: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.detail, lineHeight: 20, marginTop: 12 },
  button: { marginVertical: 8 },
  buttonText: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.small, fontWeight: "500" },
  service: { flexDirection: "row", alignItems: "center", minHeight: 72, gap: space.lg },
  serviceText: { flex: 1 },
  divider: { borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth },
  errorBox: { marginTop: 20, gap: space.sm },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: textSize.small },
  retry: { alignSelf: "flex-start", paddingVertical: 12, paddingRight: 24 },
  loading: { marginTop: 16 },
  signIn: { marginTop: 12, gap: space.xs },
  input: { marginTop: 8 },
  version: { color: colors.faint, fontFamily: fonts.sans, fontSize: textSize.caption, marginTop: 32 },
});
