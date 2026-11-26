import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import {
  GENERAL_STAGE, command, currentSession, endpointRequest, endpoints, playingOutputs, sessions, setSession, setStages,
  type Endpoint, type Output, type Session, type SessionView, type Stage,
} from "./client";
import { Icon } from "./Icons";
import { phoneEndpointInfo, phoneLatencyMs, setPhoneLatencyMs, subscribePhoneEndpoint, subscribePhoneLatency } from "./phoneEndpoint";
import { PHONE_DEVICE_ID } from "./phonePlayback";
import { subscribeSystemVolume } from "../modules/ambra-activity/src";
import { Sheet } from "./Sheet";
import { VolumeSlider } from "./shell/Slider";
import { colors, fonts, glass, haptic, radius, space, springs, textSize } from "./theme";
import { Touchable } from "./Touchable";

type Row = { output: Output; syncs: boolean; offline: boolean; detail?: string; phone: boolean };
const key = (output: Output) => `${output.endpointId}:${output.deviceId}`;
const same = (a: Output) => (b: Output) => key(a) === key(b);
const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;

/**
 * Where the session plays, as desktop's volume menu: tap an output to play there alone, tap the
 * circle beside it to play there too, in step. Each output playing has its own volume. Stages
 * (named groups of outputs, made on desktop) and the server's other sessions sit above.
 */
export function OutputPicker({ view, onClose }: { view: SessionView | null; onClose: () => void }) {
  const phone = useSyncExternalStore(subscribePhoneEndpoint, phoneEndpointInfo);
  const [devices, setDevices] = useState<Endpoint[]>([]);
  const [list, setList] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const session = currentSession();
  useEffect(() => {
    const abort = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const [found, all] = await Promise.all([endpoints(abort.signal), sessions(abort.signal).catch(() => [])]);
        if (!abort.signal.aborted) { setDevices(found); setList(all); }
      } catch (reason) {
        if (!abort.signal.aborted) setError(message(reason, "Couldn't load audio outputs."));
      } finally { running = false; if (!abort.signal.aborted) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { abort.abort(); clearInterval(timer); };
  }, [session]);

  const playing = playingOutputs(view);
  const playingKey = playing.map(key).join("|");
  // Each output's own saved level, as desktop reads it (`native_audio_settings` there).
  useEffect(() => {
    let disposed = false;
    for (const output of playing) {
      void endpointRequest<{ outputs?: { id: string; volume?: number }[] }>(output.endpointId, "command", { method: "POST", body: JSON.stringify({ command: "native_audio_settings", args: {} }) })
        .then(settings => {
          const level = settings.outputs?.find(entry => entry.id === output.deviceId)?.volume;
          if (!disposed && level !== undefined) setVolumes(current => ({ ...current, [key(output)]: current[key(output)] ?? level }));
        }).catch(() => {});
    }
    return () => { disposed = true; };
    // playingKey names the outputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingKey]);

  const current = list.find(item => item.id === session);
  const stages: Stage[] | null = current?.stages ? [
    ...(current.stages.some(stage => stage.id === GENERAL_STAGE) ? [] : [{ id: GENERAL_STAGE, name: "General", outputs: playing }]),
    ...current.stages,
  ] : null;
  const activeStage = current?.activeStage ?? GENERAL_STAGE;

  const rows: Row[] = [];
  if (phone?.id) rows.push({
    output: { endpointId: phone.id, endpointName: phone.name, deviceId: PHONE_DEVICE_ID, deviceName: "This phone" },
    syncs: true, offline: !phone.ready, phone: true, detail: phone.error ?? (!phone.ready ? "Connecting…" : undefined),
  });
  const others: Row[] = [];
  for (const endpoint of devices) {
    if (endpoint.id === phone?.id) continue;
    for (const device of endpoint.devices) others.push({
      output: { endpointId: endpoint.id, endpointName: endpoint.name, deviceId: device.id, deviceName: device.name },
      syncs: endpoint.status?.syncV1 === true, offline: false, phone: false, detail: endpoint.name,
    });
  }
  for (const output of playing) {
    if (![...rows, ...others].some(row => same(row.output)(output))) others.push({ output, syncs: true, offline: true, phone: false, detail: `${output.endpointName} · offline` });
  }
  others.sort((a, b) => a.output.deviceName.localeCompare(b.output.deviceName, undefined, { sensitivity: "base", numeric: true }) || a.output.endpointName.localeCompare(b.output.endpointName));
  rows.push(...others);

  const run = async (id: string, work: () => Promise<unknown>) => {
    setPending(id);
    setError(null);
    try { await work(); haptic.success(); }
    catch (reason) { haptic.error(); setError(message(reason, "Couldn't change the output. Please try again.")); }
    finally { setPending(null); }
  };
  // Picking outputs by hand plays them on the General stage.
  const playGeneral = (outputs: Output[]) => run(outputs.map(key).join("|"), async () => {
    if (stages) await setStages(session, stages.map(stage => stage.id === GENERAL_STAGE ? { ...stage, outputs } : stage).filter(stage => stage.outputs.length > 0), GENERAL_STAGE);
    await (outputs.length === 1 ? command("output", { output: outputs[0] }) : command("outputs", { outputs }));
  });
  const playStage = (stage: Stage) => run(stage.id, async () => {
    if (stages) await setStages(session, stages.filter(other => other.outputs.length > 0), stage.id);
    if (stage.outputs.length) await command("outputs", { outputs: stage.outputs });
    for (const output of stage.outputs) {
      const level = stage.volumes?.[key(output)];
      if (level !== undefined) await command("volume", { volume: level, output });
    }
  });
  const toggle = (output: Output) => {
    const next = playing.some(same(output)) ? playing.filter(member => !same(output)(member)) : [...playing, output];
    if (next.length) void playGeneral(next);
  };
  // Levels go out as the finger moves, at most every 80 ms per output.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const levels = useRef(new Map<string, number>());
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);
  // This phone's level is the system volume: its slider moves with the buttons as they're pressed.
  // Not while the finger is on it, which would echo the slider's own changes back at it.
  const touched = useRef(0);
  const phoneKey = phone?.id ? key({ endpointId: phone.id, endpointName: phone.name, deviceId: PHONE_DEVICE_ID, deviceName: "This phone" }) : null;
  useEffect(() => {
    if (!phoneKey) return;
    return subscribeSystemVolume(level => {
      if (Date.now() - touched.current < 400) return;
      setVolumes(current => ({ ...current, [phoneKey]: Math.round(level * 100) }));
    });
  }, [phoneKey]);
  const setVolume = (output: Output, level: number) => {
    const id = key(output);
    if (id === phoneKey) touched.current = Date.now();
    levels.current.set(id, level);
    setVolumes(current => ({ ...current, [id]: level }));
    if (timers.current.has(id)) return;
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      void command("volume", { volume: levels.current.get(id) ?? level, output }).catch(reason => setError(message(reason, "Couldn't set the volume.")));
    }, 80));
  };

  return (
    <Sheet label="Audio outputs" tall onClose={onClose} grip={<View style={styles.heading}>
      <Text style={styles.title}>Output</Text>
      <Text style={styles.subtitle} numberOfLines={1}>{playing.length > 1 ? `Playing on ${playing.length} outputs in step` : playing[0] ? `Playing on ${playing[0].deviceName}` : "Choose where to play"}</Text>
    </View>}>
      {() => <ScrollView scrollsToTop={false} style={styles.list} contentContainerStyle={styles.listContent}>
        {list.length > 1 && <>
          <Text style={styles.section}>Session</Text>
          <Chips items={list.map(item => ({ id: item.id, label: item.name, detail: item.playing ? "Playing" : undefined }))} selected={session} onSelect={id => { haptic.tick(); setSession(id); }} />
        </>}
        {stages && stages.length > 1 && <>
          <Text style={styles.section}>Stage</Text>
          <Chips items={stages.map(stage => ({ id: stage.id, label: stage.name }))} selected={activeStage} busy={pending} onSelect={id => { const stage = stages.find(item => item.id === id); if (stage) void playStage(stage); }} />
        </>}
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        <Text style={styles.section}>Outputs</Text>
        {rows.map(row => {
          const on = playing.some(same(row.output));
          const waiting = pending?.split("|").includes(key(row.output)) ?? false;
          const level = volumes[key(row.output)] ?? 100;
          return <View key={key(row.output)} style={[styles.card, on && styles.cardOn]}>
            <View style={styles.rowLine}>
              <Touchable
                accessibilityRole="radio"
                accessibilityLabel={`Play only on ${row.output.deviceName}${row.detail ? `, ${row.detail}` : ""}`}
                accessibilityState={{ checked: on && playing.length === 1, disabled: row.offline || pending !== null }}
                disabled={row.offline || pending !== null}
                scale={0.97}
                haptic="select"
                onPress={() => { if (!(on && playing.length === 1)) void playGeneral([row.output]); }}
                style={styles.row}
              >
                <View style={[styles.deviceIcon, on && styles.deviceIconOn]}><Icon name="output" size={15} color={on ? colors.black : colors.secondary} /></View>
                <View style={styles.name}>
                  <Text numberOfLines={1} style={[styles.device, on && styles.deviceOn]}>{row.output.deviceName}</Text>
                  {row.detail && <Text numberOfLines={1} style={styles.detail}>{row.detail}</Text>}
                </View>
                {waiting && <ActivityIndicator color={colors.text} size="small" />}
              </Touchable>
              {<GroupToggle on={on} disabled={row.offline || pending !== null || !row.syncs || (on && playing.length === 1)}
                label={row.syncs ? `Play on ${row.output.deviceName} too` : `Update Ambra on ${row.output.endpointName} to play in step`} onPress={() => toggle(row.output)} />}
            </View>
            {on && !row.offline && <VolumeSlider value={level} label={`${row.output.deviceName} volume`} onChange={value => setVolume(row.output, value)} />}
            {on && row.phone && playing.length > 1 && <PhoneDelay />}
          </View>;
        })}
        {loading && !rows.length && <ActivityIndicator color={colors.muted} style={styles.loading} />}
        {!loading && !rows.length && <Text style={styles.empty}>No outputs are online. Open Ambra on a computer to play there.</Text>}
      </ScrollView>}
    </Sheet>
  );
}

/**
 * How late this phone's sound reaches the ear beyond what it can tell (Bluetooth, AirPlay):
 * raise it until the phone lines up with the other outputs.
 */
function PhoneDelay() {
  const delay = useSyncExternalStore(subscribePhoneLatency, phoneLatencyMs);
  const step = (by: number) => { haptic.tick(); setPhoneLatencyMs(delay + by); };
  return <View style={styles.delay}>
    <View style={styles.delayText}>
      <Text style={styles.delayLabel}>Speaker delay</Text>
    </View>
    <Touchable accessibilityRole="button" accessibilityLabel="Less delay" haptic={null} scale={0.85} onPress={() => step(-10)} onLongPress={() => step(-50)} style={styles.delayButton}><Text style={styles.delaySign}>−</Text></Touchable>
    <Text accessibilityLiveRegion="polite" style={styles.delayValue}>{delay} ms</Text>
    <Touchable accessibilityRole="button" accessibilityLabel="More delay" haptic={null} scale={0.85} onPress={() => step(10)} onLongPress={() => step(50)} style={styles.delayButton}><Text style={styles.delaySign}>+</Text></Touchable>
  </View>;
}

/** A row of choices with a pill that springs from one to the next. */
function Chips({ items, selected, busy, onSelect }: { items: { id: string; label: string; detail?: string }[]; selected: string; busy?: string | null; onSelect(id: string): void }) {
  return <ScrollView horizontal scrollsToTop={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
    {items.map(item => {
      const on = item.id === selected;
      return <Touchable key={item.id} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={item.label} haptic="tick" scale={0.92} onPress={() => onSelect(item.id)} style={[styles.chip, on && styles.chipOn]}>
        <Text numberOfLines={1} style={[styles.chipText, on && styles.chipTextOn]}>{item.label}</Text>
        {busy === item.id ? <ActivityIndicator size="small" color={on ? colors.black : colors.text} /> : item.detail && <View style={[styles.dot, on && styles.dotOn]} />}
      </Touchable>;
    })}
  </ScrollView>;
}

/** The circle that adds an output to the group; it fills with a springy pop. */
function GroupToggle({ on, disabled, label, onPress }: { on: boolean; disabled: boolean; label: string; onPress(): void }) {
  const fill = useSharedValue(on ? 1 : 0);
  useEffect(() => { fill.set(withSpring(on ? 1 : 0, springs.bouncy)); }, [on, fill]);
  const dot = useAnimatedStyle(() => ({ transform: [{ scale: fill.get() }], opacity: Math.min(1, fill.get() * 2) }));
  return <Touchable accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled }} accessibilityLabel={label} disabled={disabled} haptic="firm" scale={0.8} hitSlop={8} onPress={onPress} style={styles.toggle}>
    <View style={[styles.ring, on && styles.ringOn]}>
      <Animated.View style={[styles.ringFill, dot]}><Icon name="check" size={12} color={colors.black} /></Animated.View>
    </View>
  </Touchable>;
}

const styles = StyleSheet.create({
  heading: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 8, gap: 2 },
  title: { fontFamily: fonts.serif, color: colors.text, fontSize: 32, fontWeight: "500" },
  subtitle: { fontFamily: fonts.sans, color: colors.muted, fontSize: textSize.caption },
  list: { flex: 1 },
  listContent: { paddingBottom: 24, gap: space.sm },
  section: { fontFamily: fonts.sans, fontSize: textSize.caption, fontWeight: "600", letterSpacing: 0.7, textTransform: "uppercase", color: colors.secondary, paddingHorizontal: 8, paddingTop: 14 },
  chips: { gap: space.sm, paddingHorizontal: 4, paddingVertical: 4 },
  chip: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 38, paddingHorizontal: 16, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.raised },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontFamily: fonts.sans, color: colors.secondary, fontSize: textSize.detail, fontWeight: "600", maxWidth: 160 },
  chipTextOn: { color: colors.black },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  dotOn: { backgroundColor: colors.black },
  card: { borderRadius: radius.lg, borderCurve: "continuous", paddingHorizontal: 6, paddingBottom: 2, borderWidth: StyleSheet.hairlineWidth, borderColor: "transparent" },
  cardOn: { backgroundColor: colors.raised, borderColor: glass.border, paddingHorizontal: 12, paddingBottom: 6 },
  rowLine: { flexDirection: "row", alignItems: "center" },
  row: { flex: 1, minHeight: 60, flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: radius.md },
  deviceIcon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: "#151515" },
  deviceIconOn: { backgroundColor: colors.text },
  name: { flex: 1, gap: 2 },
  device: { fontFamily: fonts.sans, fontSize: textSize.body, color: colors.secondary },
  deviceOn: { color: colors.text, fontWeight: "600" },
  detail: { fontFamily: fonts.sans, color: colors.muted, fontSize: textSize.caption },
  toggle: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  ring: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: "#4a4a4a", alignItems: "center", justifyContent: "center" },
  ringOn: { borderColor: colors.text },
  ringFill: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" },
  error: { fontFamily: fonts.sans, color: colors.error, fontSize: textSize.detail, lineHeight: 20, paddingHorizontal: 8 },
  empty: { fontFamily: fonts.sans, color: colors.muted, paddingVertical: 24, paddingHorizontal: 8, lineHeight: 20 },
  note: { fontFamily: fonts.sans, color: colors.faint, fontSize: textSize.caption, lineHeight: 18, paddingHorizontal: 8, paddingTop: 8 },
  loading: { paddingVertical: 24 },
  delay: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: 4, paddingBottom: 6 },
  delayText: { flex: 1, gap: 2 },
  delayLabel: { fontFamily: fonts.sans, color: colors.text, fontSize: textSize.small, fontWeight: "600" },
  delayButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#1a1a1a" },
  delaySign: { fontFamily: fonts.sans, color: colors.text, fontSize: 18, fontWeight: "600" },
  delayValue: { minWidth: 58, textAlign: "center", fontFamily: fonts.sans, color: colors.text, fontSize: textSize.small, fontVariant: ["tabular-nums"] },
});
