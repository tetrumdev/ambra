import { useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { LyricSync } from "./lyricSync";
import { Touchable } from "./Touchable";
import { Icon } from "./Icons";
import { fonts, colors, radius, space, textSize } from "./theme";

export function LyricSyncControls({ value, loaded, error, following, plain, height, playing, onResume, onResync, onNudge, onReset, onToggle }: {
  value: LyricSync; loaded: boolean; error: string | null; following: boolean; plain: boolean; height: number; playing: boolean;
  onResume: () => void; onResync: () => Promise<void>; onNudge: (delta: number) => void; onReset: () => void; onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Steps back while the song plays, so the lyrics have the stage.
  const quiet = useSharedValue(1);
  useEffect(() => { quiet.set(withTiming(playing && !open ? 0.45 : 1, { duration: 400, easing: Easing.out(Easing.cubic) })); }, [playing, open, quiet]);
  const quietStyle = useAnimatedStyle(() => ({ opacity: quiet.get() }));
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
        <ScrollView scrollsToTop={false} style={{ maxHeight: Math.max(120, height - 72) }} contentContainerStyle={styles.panelContent}>
          <Text style={styles.title}>Lyric timing</Text>
          <Text style={styles.detail}>{timing}</Text>
          <Touchable accessibilityRole="button" disabled={busy} onPress={() => { void resync(); }} style={styles.action}><Text style={styles.label}>{busy ? "Re-syncing…" : "Re-sync to playback"}</Text></Touchable>
          {!plain && <>
            <View style={styles.nudges}>{[-500, -100, 100, 500].map(delta => <Touchable key={delta} accessibilityRole="button" accessibilityLabel={`Show lyrics ${Math.abs(delta) / 1000} seconds ${delta > 0 ? "earlier" : "later"}`} disabled={!loaded} onPress={() => onNudge(delta)} style={styles.nudge}><Text style={styles.label}>{delta > 0 ? "+" : "−"}{Math.abs(delta) / 1000}</Text></Touchable>)}</View>
            <Touchable accessibilityRole="button" disabled={!loaded} onPress={onReset} style={styles.action}><Text style={styles.label}>Reset timing</Text></Touchable>
          </>}
          <Touchable accessibilityRole="button" disabled={!loaded} onPress={() => { onToggle(); setOpen(false); }} style={styles.action}><Text style={styles.label}>{value.unsynced ? "Turn sync back on" : "Turn sync off for this song"}</Text></Touchable>
          {!!(failure || error) && <Text accessibilityRole="alert" style={styles.failure}>{failure || error}</Text>}
        </ScrollView>
      </View>
    </>}
    {!plain && !following && <Touchable accessibilityRole="button" accessibilityLabel="Return to current lyric" scale={0.96} onPress={onResume} style={styles.resume}><Icon name="lyrics" size={15} /><Text style={styles.label}>Live lyrics</Text></Touchable>}
    <Animated.View style={[styles.sync, quietStyle]}>
      <Touchable accessibilityRole="button" accessibilityLabel="Adjust lyric sync" accessibilityState={{ expanded: open }} hitSlop={8} scale={0.9} onPress={() => setOpen(value => !value)} style={styles.control}><Text style={styles.small}>Sync</Text></Touchable>
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  resume: { position: "absolute", bottom: 8, alignSelf: "center", minHeight: 40, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: space.sm, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.14)", backgroundColor: "rgba(30,30,30,0.7)" },
  sync: { position: "absolute", bottom: 12, right: 18 },
  control: { minHeight: 28, paddingHorizontal: 11, justifyContent: "center", borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.14)", backgroundColor: "rgba(30,30,30,0.6)" },
  small: { color: colors.secondary, fontFamily: fonts.sans, fontSize: textSize.caption, fontWeight: "500" },
  panel: { position: "absolute", bottom: 52, right: 14, width: 280, maxWidth: "94%", backgroundColor: "#181818", borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: "#484848", overflow: "hidden" },
  panelContent: { padding: 16, gap: space.md },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 17, fontWeight: "600" },
  detail: { color: "#b3b3b3", fontFamily: fonts.sans, fontSize: textSize.caption, lineHeight: 17 },
  label: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.detail, fontWeight: "500" },
  action: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderRadius: radius.field, backgroundColor: "#272727" },
  nudges: { flexDirection: "row", gap: 6 },
  nudge: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: colors.selected },
  failure: { color: "#ffb4b4", fontFamily: fonts.sans, fontSize: textSize.caption, lineHeight: 17 },
});
