import { useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { LyricSync } from "./lyricSync";
import { Touchable } from "./Touchable";
import { Icon } from "./Icons";
import { fonts } from "./theme";

export function LyricSyncControls({ value, loaded, error, following, plain, height, onResume, onResync, onNudge, onReset, onToggle }: {
  value: LyricSync; loaded: boolean; error: string | null; following: boolean; plain: boolean; height: number;
  onResume: () => void; onResync: () => Promise<void>; onNudge: (delta: number) => void; onReset: () => void; onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => { setOpen(false); return true; });
    return () => back.remove();
  }, [open]);
  const resync = async () => {
    setBusy(true);
    setFailure(null);
    try { await onResync(); setOpen(false); }
    catch (error) { setFailure(error instanceof Error ? error.message : "Couldn’t refresh playback. Try again."); }
    finally { setBusy(false); }
  };
  const timing = value.correctionMs === 0 ? "Original timing" : `${(Math.abs(value.correctionMs) / 1000).toFixed(1)} s ${value.correctionMs > 0 ? "earlier" : "later"}`;
  return <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
    {open && <>
      <Pressable accessibilityLabel="Close lyric timing" accessibilityRole="button" style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
      <View accessibilityViewIsModal onAccessibilityEscape={() => setOpen(false)} style={styles.panel}>
        <ScrollView style={{ maxHeight: Math.max(120, height - 72) }} contentContainerStyle={styles.panelContent}>
          <Text style={styles.title}>Lyric timing</Text>
          <Text style={styles.detail}>{timing} · Saved for this song on this phone</Text>
          <Touchable accessibilityRole="button" disabled={busy} onPress={() => { void resync(); }} style={styles.action}><Text style={styles.label}>{busy ? "Re-syncing…" : "Re-sync to playback"}</Text></Touchable>
          {!plain && <>
            <Text style={styles.detail}>+ shows lyrics sooner. − shows lyrics later.</Text>
            <View style={styles.nudges}>{[-500, -100, 100, 500].map(delta => <Touchable key={delta} accessibilityRole="button" accessibilityLabel={`Show lyrics ${Math.abs(delta) / 1000} seconds ${delta > 0 ? "earlier" : "later"}`} disabled={!loaded} onPress={() => onNudge(delta)} style={styles.nudge}><Text style={styles.label}>{delta > 0 ? "+" : "−"}{Math.abs(delta) / 1000}</Text></Touchable>)}</View>
            <Touchable accessibilityRole="button" disabled={!loaded} onPress={onReset} style={styles.action}><Text style={styles.label}>Reset timing</Text></Touchable>
          </>}
          <Touchable accessibilityRole="button" disabled={!loaded} onPress={() => { onToggle(); setOpen(false); }} style={styles.action}><Text style={styles.label}>{value.unsynced ? "Turn sync back on" : "Turn sync off for this song"}</Text></Touchable>
          {!!(failure || error) && <Text accessibilityRole="alert" style={styles.failure}>{failure || error}</Text>}
        </ScrollView>
      </View>
    </>}
    <View style={styles.controls}>
      {!plain && !following && <Touchable accessibilityRole="button" accessibilityLabel="Return to current lyric" scale={0.96} onPress={onResume} style={styles.control}><Icon name="lyrics" size={15} /><Text style={styles.label}>Live lyrics</Text></Touchable>}
      <Touchable accessibilityRole="button" accessibilityLabel="Adjust lyric sync" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={styles.control}><Text style={styles.label}>Sync</Text></Touchable>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  controls: { position: "absolute", bottom: 8, alignSelf: "center", flexDirection: "row", borderRadius: 100, borderWidth: StyleSheet.hairlineWidth, borderColor: "#454545", backgroundColor: "rgba(22,22,22,0.96)", paddingHorizontal: 5 },
  control: { minHeight: 44, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", gap: 8 },
  panel: { position: "absolute", bottom: 64, alignSelf: "center", width: 280, maxWidth: "94%", backgroundColor: "#181818", borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: "#484848", overflow: "hidden" },
  panelContent: { padding: 16, gap: 12 },
  title: { color: "white", fontFamily: fonts.sans, fontSize: 17, fontWeight: "600" },
  detail: { color: "#b3b3b3", fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  label: { color: "white", fontFamily: fonts.sans, fontSize: 13, fontWeight: "500" },
  action: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderRadius: 10, backgroundColor: "#272727" },
  nudges: { flexDirection: "row", gap: 6 },
  nudge: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: "#303030" },
  failure: { color: "#ffb4b4", fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
});
