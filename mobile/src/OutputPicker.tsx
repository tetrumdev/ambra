import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { command, endpoints, type Endpoint, type Output, type SessionView } from "./client";
import { Icon } from "./Icons";
import { phoneEndpointInfo, subscribePhoneEndpoint } from "./phoneEndpoint";
import { PHONE_DEVICE_ID } from "./phonePlayback";
import { Sheet } from "./Sheet";
import { colors, fonts, haptic } from "./theme";
import { Touchable } from "./Touchable";

type Row = { output: Output; heading: string; disabled: boolean; detail?: string };
const key = (output: Output) => `${output.endpointId}:${output.deviceId}`;

export function OutputPicker({ view, onClose }: { view: SessionView | null; onClose: () => void }) {
  const phone = useSyncExternalStore(subscribePhoneEndpoint, phoneEndpointInfo);
  const [devices, setDevices] = useState<Endpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const found = await endpoints(abort.signal);
        if (!abort.signal.aborted) { setDevices(found); setLoadError(null); }
      } catch (reason) {
        if (!abort.signal.aborted) setLoadError(reason instanceof Error ? reason.message : "Couldn't load audio outputs.");
      } finally { running = false; if (!abort.signal.aborted) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [reload]);

  const rows: Row[] = [];
  if (phone?.id) rows.push({
    output: { endpointId: phone.id, endpointName: phone.name, deviceId: PHONE_DEVICE_ID, deviceName: phone.name },
    heading: "This phone", disabled: !phone.ready, detail: phone.error ?? (!phone.ready ? "Connecting…" : undefined),
  });
  for (const endpoint of devices) {
    if (endpoint.id === phone?.id) continue;
    for (const device of endpoint.devices) rows.push({ output: { endpointId: endpoint.id, endpointName: endpoint.name, deviceId: device.id, deviceName: device.name }, heading: endpoint.name, disabled: false });
  }
  const output = view?.output;
  if (output && !rows.some(row => key(row.output) === key(output))) rows.push({ output, heading: output.endpointName, disabled: true, detail: loading ? "Checking…" : "Offline" });

  const pick = async (next: Output, close: () => void) => {
    if (output && key(next) === key(output)) { close(); return; }
    setPending(key(next));
    setSelectError(null);
    try {
      await command("output", { output: next });
      haptic.success();
      close();
    } catch (reason) {
      haptic.error();
      setSelectError(reason instanceof Error ? reason.message : "Couldn't change the output. Please try again.");
    } finally { setPending(null); }
  };

  return (
    <Sheet label="Audio outputs" onClose={onClose} grip={<Text style={styles.title}>Output</Text>}>
      {close => <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {(selectError || loadError) && <View style={styles.errorRow}>
          <Text accessibilityRole="alert" style={styles.error}>{selectError ?? loadError}</Text>
          <Touchable accessibilityRole="button" onPress={() => setReload(value => value + 1)} style={styles.retry}><Text style={styles.retryText}>Retry</Text></Touchable>
        </View>}
        {rows.map((item, index) => {
          const selected = !!output && key(output) === key(item.output);
          const waiting = pending === key(item.output);
          return <View key={key(item.output)}>
            {(index === 0 || rows[index - 1].heading !== item.heading) && <Text style={styles.heading}>{item.heading}</Text>}
            <Touchable
              accessibilityRole="radio"
              accessibilityLabel={`${item.output.deviceName} on ${item.heading}`}
              accessibilityState={{ checked: selected, disabled: item.disabled || pending !== null }}
              disabled={item.disabled || pending !== null}
              highlight
              scale={0.98}
              haptic="select"
              onPress={() => { void pick(item.output, close); }}
              style={[styles.row, selected && styles.selectedRow]}
            >
              <View style={styles.name}>
                <Text numberOfLines={1} style={[styles.device, selected && styles.selected]}>{item.output.deviceName}</Text>
                {item.detail && <Text style={styles.detail}>{item.detail}</Text>}
              </View>
              <View style={styles.check}>{waiting ? <ActivityIndicator color="white" size="small" /> : selected ? <Icon name="check" size={16} /> : null}</View>
            </Touchable>
          </View>;
        })}
        {loading && !rows.length && <ActivityIndicator color={colors.muted} style={styles.loading} />}
        {!loading && !rows.length && <Text style={styles.empty}>No outputs are online.</Text>}
      </ScrollView>}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.serif, color: "white", fontSize: 32, fontWeight: "500", paddingHorizontal: 8, paddingTop: 6, paddingBottom: 4 },
  list: { flexGrow: 0 },
  listContent: { paddingBottom: 8 },
  heading: { fontFamily: fonts.sans, fontSize: 12, fontWeight: "600", letterSpacing: 0.7, textTransform: "uppercase", color: colors.secondary, paddingHorizontal: 8, paddingTop: 18, paddingBottom: 6 },
  row: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14, borderCurve: "continuous" },
  selectedRow: { backgroundColor: "rgba(255, 255, 255, 0.06)" },
  check: { width: 22, alignItems: "center" },
  name: { flex: 1, gap: 4 },
  device: { fontFamily: fonts.sans, fontSize: 16, color: colors.secondary },
  selected: { color: "white", fontWeight: "600" },
  detail: { fontFamily: fonts.sans, color: colors.muted, fontSize: 12 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8 },
  error: { flex: 1, fontFamily: fonts.sans, color: colors.error, fontSize: 13, lineHeight: 20 },
  retry: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  retryText: { fontFamily: fonts.sans, color: "white", fontWeight: "600", fontSize: 14 },
  empty: { fontFamily: fonts.sans, color: colors.muted, paddingVertical: 24, paddingHorizontal: 8 },
  loading: { paddingVertical: 24 },
});
